// graphql.ts — a small GraphQL executor for the documented operations only.
//
// Supported: viewer, repository(owner, name), node(id), __type(name), __schema;
// mutations createIssue, closeIssue, createPullRequest, mergePullRequest, addComment.
// Connections (issues/pullRequests/files) with first/after cursor pagination.
// Unknown fields -> HTTP 200 with an `errors` array naming the field (partial data kept).
// Unknown repo -> data.repository = null, no errors. Batch = JSON array, answered in order.

import { VIEWER, getRepo, getRepoById, type Issue, type PullRequest, type Repo } from './store.ts';
import { addComment, createIssue, createPR, mergePR, patchIssue, prFiles, prHasConflict } from './service.ts';
import { globalId, parseGlobalId } from './rest.ts';

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
  selectionSet: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: Array<{ name: string; defaultValue: ValueNode | null }>;
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos]!)) this.pos++;
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipIgnored();
    return this.src[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skipIgnored();
    if (this.src[this.pos] !== ch) throw new Error(`expected ${ch} at ${this.pos}`);
    this.pos++;
  }

  private matchWord(word: string): boolean {
    this.skipIgnored();
    if (this.src.startsWith(word, this.pos)) {
      const after = this.src[this.pos + word.length] ?? '';
      if (after === '' || !/[A-Za-z0-9_]/.test(after)) {
        this.pos += word.length;
        return true;
      }
    }
    return false;
  }

  private readName(): string {
    this.skipIgnored();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  private readString(): string {
    this.skipIgnored();
    if (this.src[this.pos] !== '"') throw new Error(`expected string at ${this.pos}`);
    this.pos++;
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch === '\\') {
        const next = this.src[this.pos + 1]!;
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else out += next;
        this.pos += 2;
        continue;
      }
      out += ch;
      this.pos++;
    }
    throw new Error('unterminated string');
  }

  private readNumber(): ValueNode {
    this.skipIgnored();
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected number at ${this.pos}`);
    this.pos += m[0].length;
    const raw = m[0];
    if (/[.eE]/.test(raw)) return { kind: 'float', value: parseFloat(raw) };
    return { kind: 'int', value: parseInt(raw, 10) };
  }

  parseValue(): ValueNode {
    this.skipIgnored();
    const ch = this.src[this.pos]!;
    if (ch === '$') {
      this.pos++;
      return { kind: 'variable', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '[') {
      this.pos++;
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.pos++;
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}') {
        const name = this.readName();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) return this.readNumber();
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  private parseArgs(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek() !== '(') return args;
    this.pos++;
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }

  private parseDirectives(): Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }> {
    const out: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }> = [];
    while (this.peek() === '@') {
      this.pos++;
      const name = this.readName();
      out.push({ name, args: this.parseArgs() });
    }
    return out;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const sels: SelectionNode[] = [];
    while (this.peek() !== '}') sels.push(this.parseSelection());
    this.expect('}');
    return sels;
  }

  private parseSelection(): SelectionNode {
    if (this.src.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipIgnored();
      if (this.peek() === '{' || /^[A-Za-z_]/.test(this.peek())) {
        // inline fragment: optional "on Type"
        let typeCondition: string | null = null;
        if (this.matchWord('on')) typeCondition = this.readName();
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      const name = this.readName();
      const directives = this.parseDirectives();
      return { kind: 'spread', name, directives };
    }
    const first = this.readName();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.pos++;
      alias = first;
      name = this.readName();
    }
    const args = this.parseArgs();
    const directives = this.parseDirectives();
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.src.length) {
      this.skipIgnored();
      if (this.pos >= this.src.length) break;
      if (this.matchWord('fragment')) {
        const name = this.readName();
        if (!this.matchWord('on')) throw new Error('fragment needs "on"');
        const typeCondition = this.readName();
        const selectionSet = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selectionSet });
        continue;
      }
      let type: 'query' | 'mutation' = 'query';
      if (this.matchWord('query')) type = 'query';
      else if (this.matchWord('mutation')) type = 'mutation';
      let name: string | null = null;
      if (/[A-Za-z_]/.test(this.peek())) name = this.readName();
      // variable definitions
      const varDefs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
      if (this.peek() === '(') {
        this.pos++;
        while (this.peek() !== ')') {
          this.expect('$');
          const vname = this.readName();
          this.expect(':');
          // type (skip: a name, possibly [..] and !)
          this.skipIgnored();
          let depth = 0;
          while (this.pos < this.src.length) {
            const ch = this.src[this.pos]!;
            if (ch === '[') depth++;
            else if (ch === ']') depth--;
            else if (ch === '(' || ch === ')' || ch === ',' || ch === '{' || ch === '$' || ch === '@') break;
            if (depth === 0 && (ch === '=' || ch === ')' || ch === ',')) break;
            this.pos++;
          }
          let defaultValue: ValueNode | null = null;
          if (this.peek() === '=') {
            this.pos++;
            defaultValue = this.parseValue();
          }
        }
        this.expect(')');
      }
      const directives = this.parseDirectives();
      const selectionSet = this.parseSelectionSet();
      operations.push({ type, name, varDefs, directives, selectionSet });
    }
    return { operations, fragments };
  }
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function evalValue(node: ValueNode, vars: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => evalValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, vars);
      return out;
    }
  }
}

function evalArgs(args: Array<{ name: string; value: ValueNode }>, vars: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = evalValue(a.value, vars);
  return out;
}

function directiveSkip(directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>, vars: Variables): boolean {
  for (const d of directives) {
    const args = evalArgs(d.args, vars);
    if (d.name === 'skip' && args.if === true) return true;
    if (d.name === 'include' && args.if === false) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// model -> GraphQL values
// ---------------------------------------------------------------------------

type GqlValue = Record<string, unknown> & { __typename?: string };

function userValue(login: string): GqlValue {
  return { __typename: 'User', login, id: login === VIEWER.login ? VIEWER.id : 0, name: login === VIEWER.login ? VIEWER.name : login, email: login === VIEWER.login ? VIEWER.email : '' };
}

function refValue(name: string): GqlValue {
  return { __typename: 'Ref', name };
}

function repoValue(repo: Repo): GqlValue {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: globalId('repo', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    owner: userValue(repo.owner),
    defaultBranchRef: refValue(repo.default_branch),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
  };
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: globalId('issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    author: userValue(issue.user),
    repository: repoValue(repo),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function prValue(repo: Repo, pr: PullRequest): GqlValue {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pr: pr,
    id: globalId('pr', `${repo.id}:${pr.number}`),
    number: pr.number,
    title: pr.title,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    body: pr.body,
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    mergeable: pr.state === 'open' ? (prHasConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN',
    merged: pr.merged,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    author: userValue(pr.user),
    repository: repoValue(repo),
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
}

function commentValue(repo: Repo, kind: string, number: number, comment: { id: number; body: string; user: string; created_at: string; updated_at: string }): GqlValue {
  return {
    __typename: 'Comment',
    id: globalId('comment', `${repo.id}:${kind}:${number}:${comment.id}`),
    databaseId: comment.id,
    body: comment.body,
    author: userValue(comment.user),
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice(7));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  let items = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    items = items.filter((i) => wanted.has(i.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  items.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = cursorNumber(args.after as string | undefined);
  if (after !== null) {
    items = direction === 'ASC' ? items.filter((i) => i.number > after) : items.filter((i) => i.number < after);
  }
  const totalCount = items.length;
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(0, Math.max(0, first));
  const nodes = page.map((i) => issueValue(repo, i));
  const edges = page.map((i) => ({ __typename: 'IssueEdge', node: issueValue(repo, i), cursor: cursorFor(i.number) }));
  return {
    __typename: 'IssueConnection',
    nodes,
    edges,
    totalCount,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: items.length > page.length,
      hasPreviousPage: after !== null,
      startCursor: page.length ? cursorFor(page[0]!.number) : null,
      endCursor: page.length ? cursorFor(page[page.length - 1]!.number) : null,
    },
  };
}

function prConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  let items = [...repo.prs.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    items = items.filter((p) => wanted.has(p.merged ? 'MERGED' : p.state.toUpperCase()));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  items.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = cursorNumber(args.after as string | undefined);
  if (after !== null) {
    items = direction === 'ASC' ? items.filter((p) => p.number > after) : items.filter((p) => p.number < after);
  }
  const totalCount = items.length;
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(0, Math.max(0, first));
  const nodes = page.map((p) => prValue(repo, p));
  const edges = page.map((p) => ({ __typename: 'PullRequestEdge', node: prValue(repo, p), cursor: cursorFor(p.number) }));
  return {
    __typename: 'PullRequestConnection',
    nodes,
    edges,
    totalCount,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: items.length > page.length,
      hasPreviousPage: after !== null,
      startCursor: page.length ? cursorFor(page[0]!.number) : null,
      endCursor: page.length ? cursorFor(page[page.length - 1]!.number) : null,
    },
  };
}

function prFilesConnection(repo: Repo, pr: PullRequest, args: Record<string, unknown>): GqlValue {
  const files = prFiles(repo, pr);
  const first = typeof args.first === 'number' ? args.first : files.length;
  const page = files.slice(0, Math.max(0, first));
  const nodes = page.map((f) => ({
    __typename: 'PullRequestFile',
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED',
  }));
  const edges = nodes.map((n) => ({ __typename: 'PullRequestFileEdge', node: n, cursor: cursorFor(0) }));
  return {
    __typename: 'PullRequestFileConnection',
    nodes,
    edges,
    totalCount: files.length,
    pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}

// __type introspection data
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'repository', 'comments', 'url'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'title', 'body', 'files', 'createdAt', 'updatedAt', 'author', 'repository', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};

function typeValue(name: string): GqlValue {
  const isEnum = name === 'SearchType' || name === 'IssueState' || name === 'PullRequestState' || name === 'OrderDirection';
  const enumValues: Record<string, string[]> = {
    SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
    IssueState: ['OPEN', 'CLOSED'],
    PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
    OrderDirection: ['ASC', 'DESC'],
  };
  return {
    __typename: '__Type',
    name,
    kind: isEnum ? 'ENUM' : 'OBJECT',
    description: null,
    fields: isEnum ? null : (TYPE_FIELDS[name] ?? []).map((f) => ({ __typename: '__Field', name: f, description: null, args: [], type: { __typename: '__Type', name: 'String', kind: 'SCALAR' } })),
    enumValues: isEnum ? (enumValues[name] ?? []).map((v) => ({ __typename: '__EnumValue', name: v, description: null })) : null,
  };
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface ExecCtx {
  vars: Variables;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

function resolveField(typeName: string, parent: GqlValue, field: FieldNode, ctx: ExecCtx): unknown {
  const args = evalArgs(field.args, ctx.vars);
  const name = field.name;
  if (name === '__typename') return typeName;

  if (typeName === 'Query') {
    if (name === 'viewer') return userValue(VIEWER.login);
    if (name === 'repository') {
      const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoValue(repo) : null;
    }
    if (name === 'node') {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.kind === 'repo') {
        const repo = getRepoById(Number(parsed.key));
        return repo ? repoValue(repo) : null;
      }
      if (parsed.kind === 'issue') {
        const [repoId, num] = parsed.key.split(':');
        const repo = getRepoById(Number(repoId));
        const issue = repo?.issues.get(Number(num));
        return repo && issue ? issueValue(repo, issue) : null;
      }
      if (parsed.kind === 'pr') {
        const [repoId, num] = parsed.key.split(':');
        const repo = getRepoById(Number(repoId));
        const pr = repo?.prs.get(Number(num));
        return repo && pr ? prValue(repo, pr) : null;
      }
      if (parsed.kind === 'user') return userValue(parsed.key);
      return null;
    }
    if (name === '__type') return typeValue(String(args.name ?? ''));
    if (name === '__schema') {
      return {
        __typename: '__Schema',
        queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
        mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
        types: Object.keys(TYPE_FIELDS).map((n) => typeValue(n)),
      };
    }
  }

  if (typeName === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'repo' ? getRepoById(Number(parsed.key)) : undefined;
      if (!repo) throw new Error('Could not resolve to a Repository with the provided repositoryId');
      const result = createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      if ('error' in result) throw new Error(result.error);
      return { __typename: 'CreateIssuePayload', issue: issueValue(repo, result.issue), clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (parsed?.kind !== 'issue') throw new Error('Could not resolve to an Issue with the provided issueId');
      const [repoId, num] = parsed.key.split(':');
      const repo = getRepoById(Number(repoId));
      const issue = patchIssue(repo!, Number(num), { state: 'closed' });
      if (!issue) throw new Error('Issue not found');
      return { __typename: 'CloseIssuePayload', issue: issueValue(repo!, issue), clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'repo' ? getRepoById(Number(parsed.key)) : undefined;
      if (!repo) throw new Error('Could not resolve to a Repository with the provided repositoryId');
      const result = createPR(repo, String(input.title ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''), typeof input.body === 'string' ? input.body : '');
      if ('error' in result) throw new Error(result.error);
      return { __typename: 'CreatePullRequestPayload', pullRequest: prValue(repo, result.pr), clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (parsed?.kind !== 'pr') throw new Error('Could not resolve to a PullRequest with the provided pullRequestId');
      const [repoId, num] = parsed.key.split(':');
      const repo = getRepoById(Number(repoId));
      if (!repo) throw new Error('PullRequest not found');
      const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
      const result = mergePR(repo, Number(num), method);
      if ('error' in result) throw new Error(result.error);
      return { __typename: 'MergePullRequestPayload', pullRequest: prValue(repo, result.pr), clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (!parsed || (parsed.kind !== 'issue' && parsed.kind !== 'pr')) throw new Error('Could not resolve to an Issue or PullRequest with the provided subjectId');
      const [repoId, num] = parsed.key.split(':');
      const repo = getRepoById(Number(repoId));
      if (!repo) throw new Error('Subject not found');
      const comment = addComment(repo, parsed.kind === 'issue' ? 'issue' : 'pr', Number(num), String(input.body ?? ''));
      if (!comment) throw new Error('Subject not found');
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: commentValue(repo, parsed.kind, Number(num), comment), cursor: cursorFor(comment.id) },
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
    }
  }

  if (typeName === 'Repository') {
    const repo = (parent as GqlValue)._repo as Repo;
    if (name === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueValue(repo, issue) : null;
    }
    if (name === 'issues') return issueConnection(repo, args);
    if (name === 'pullRequest') {
      const pr = repo.prs.get(Number(args.number));
      return pr ? prValue(repo, pr) : null;
    }
    if (name === 'pullRequests') return prConnection(repo, args);
    // scalar/object fields live on the value itself
    if (name in parent) return parent[name];
  }

  if (typeName === 'Issue') {
    const issue = (parent as GqlValue)._issue as Issue;
    const repo = (parent as GqlValue)._repo as Repo;
    if (name === 'comments') {
      const nodes = issue.comments.map((c) => commentValue(repo, 'issue', issue.number, c));
      return { __typename: 'CommentConnection', nodes, edges: nodes.map((n) => ({ __typename: 'CommentEdge', node: n, cursor: cursorFor(0) })), totalCount: nodes.length, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
    if (name in parent) return parent[name];
  }

  if (typeName === 'PullRequest') {
    const pr = (parent as GqlValue)._pr as PullRequest;
    const repo = (parent as GqlValue)._repo as Repo;
    if (name === 'files') return prFilesConnection(repo, pr, args);
    if (name in parent) return parent[name];
  }

  // Generic: fields present on the value object.
  if (name in parent) return parent[name];

  // Unknown field.
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}"` });
  return null;
}

function executeSelectionSet(
  typeName: string,
  parent: GqlValue,
  selections: SelectionNode[],
  ctx: ExecCtx,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      if (directiveSkip(sel.directives, ctx.vars)) continue;
      const frag = ctx.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}"` });
        continue;
      }
      const sub = executeSelectionSet(typeName, parent, frag.selectionSet, ctx, path);
      Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'inline') {
      if (directiveSkip(sel.directives, ctx.vars)) continue;
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      const sub = executeSelectionSet(typeName, parent, sel.selectionSet, ctx, path);
      Object.assign(out, sub);
      continue;
    }
    // field
    if (directiveSkip(sel.directives, ctx.vars)) continue;
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    let value: unknown;
    try {
      value = resolveField(typeName, parent, sel, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[key] = null;
      continue;
    }
    if (sel.selectionSet === null || value === null || value === undefined) {
      out[key] = value === undefined ? null : value;
      continue;
    }
    out[key] = completeValue(value, sel.selectionSet, ctx, fieldPath);
  }
  return out;
}

function completeValue(value: unknown, selections: SelectionNode[], ctx: ExecCtx, path: Array<string | number>): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => completeValue(item, selections, ctx, [...path, i]));
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as GqlValue;
    const typeName = obj.__typename ?? 'Object';
    return executeSelectionSet(typeName, obj, selections, ctx, path);
  }
  return value;
}

function executeOperation(op: OperationNode, variables: Variables, fragments: Map<string, FragmentNode>): { data: Record<string, unknown> | null; errors?: Array<{ message: string; path?: Array<string | number> }> } {
  const ctx: ExecCtx = { vars: { ...variables }, fragments, errors: [] };
  // Apply variable defaults.
  for (const def of op.varDefs) {
    if (!(def.name in ctx.vars) || ctx.vars[def.name] === undefined) {
      if (def.defaultValue) ctx.vars[def.name] = evalValue(def.defaultValue, ctx.vars);
    }
  }
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlValue = { __typename: rootType };
  const data = executeSelectionSet(rootType, root, op.selectionSet, ctx, []);
  const result: { data: Record<string, unknown> | null; errors?: Array<{ message: string; path?: Array<string | number> }> } = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

/** Execute one GraphQL request body (object or array for batch). */
export function executeGraphQL(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => executeGraphQL(item));
  }
  const req = (body ?? {}) as Record<string, unknown>;
  const query = typeof req.query === 'string' ? req.query : '';
  const variables = (req.variables ?? {}) as Variables;
  const operationName = typeof req.operationName === 'string' ? req.operationName : null;
  if (query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let doc: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    doc = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operations found.' }] };
  }
  let op = doc.operations[0]!;
  if (operationName) {
    const found = doc.operations.find((o) => o.name === operationName);
    if (found) op = found;
  }
  try {
    return executeOperation(op, variables, doc.fragments);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
