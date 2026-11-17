// mcp.ts — Model Context Protocol, Streamable HTTP (modern revision 2026-07-28).
//
// POST /mcp with a JSON-RPC 2.0 body. Plain application/json answers.
//   server/discover -> supportedVersions, capabilities, serverInfo (also in _meta)
//   tools/list      -> the six tools, byte-identical across calls
//   tools/call      -> executes against the same store as REST (401 without Authorization)
//   unknown tool    -> JSON-RPC -32602; non-JSON body -> HTTP 400 with -32700
//   missing required args -> isError:true

import { VIEWER, getRepo } from './store.ts';
import { createIssue, createPR, createRepo, listIssues, mergePR } from './service.ts';
import { globalId } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** First present value among the candidate property names (the suite maps synonyms). */
function pick(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function repoJson(repo: ReturnType<typeof getRepo>): Record<string, unknown> | null {
  if (!repo) return null;
  return {
    id: repo.id,
    node_id: globalId('repo', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

function issueJson(repo: NonNullable<ReturnType<typeof getRepo>>, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[]; created_at: string; updated_at: string; closed_at: string | null }): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
  };
}

export interface McpOutcome {
  status: number;
  body: unknown;
  isNotification?: boolean;
}

/** Handle one POST /mcp request. `bodyText` is the raw request body; `authed` says whether a valid bearer token was presented. */
export function handleMcp(bodyText: string, authed: boolean): McpOutcome {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } },
    };
  }
  const req = (body ?? {}) as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';

  // Notifications (no id) get 202 with an empty body.
  if (method.startsWith('notifications/') || (req.method !== undefined && id === null && method !== '')) {
    if (method.startsWith('notifications/')) return { status: 202, body: null, isNotification: true };
  }

  const result = (value: unknown): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, result: value } });
  const rpcError = (code: number, message: string): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });
  const toolResult = (value: unknown, isError = false): McpOutcome =>
    result({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) });

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return result({
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'initialize') {
    return result({
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    if (!authed) {
      return { status: 401, body: { jsonrpc: '2.0', id, error: { code: -32000, message: 'Requires authentication' } } };
    }
    const params = (req.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = ((params.arguments ?? {}) as Record<string, unknown>) ?? {};
    return executeTool(toolName, args, toolResult, rpcError);
  }

  if (method === 'ping') return result({});

  return rpcError(-32601, `Method not found: ${method}`);
}

function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  toolResult: (value: unknown, isError?: boolean) => McpOutcome,
  rpcError: (code: number, message: string) => McpOutcome,
): McpOutcome {
  // Match by suffix too (e.g. "github__create_issue").
  const tool = TOOLS.find((t) => t.name === toolName || toolName.endsWith(`__${t.name}`) || toolName.endsWith(t.name));
  if (!tool) return rpcError(-32602, `Unknown tool: ${toolName}`);

  // Missing required args -> isError result.
  for (const required of tool.inputSchema.required) {
    const aliases: Record<string, string[]> = {
      name: ['name', 'repo_name', 'repository'],
      owner: ['owner', 'org', 'login'],
      repo: ['repo', 'name', 'repository'],
      title: ['title', 'issue_title'],
      head: ['head', 'head_branch', 'source'],
      base: ['base', 'base_branch', 'target'],
      pull_number: ['pull_number', 'number', 'pr_number'],
    };
    const names = aliases[required] ?? [required];
    if (pick(args, names) === undefined) {
      return toolResult({ error: `Missing required argument: ${required}` }, true);
    }
  }

  if (tool.name === 'create_repo') {
    const name = String(pick(args, ['name', 'repo_name', 'repository']));
    const description = typeof pick(args, ['description', 'about']) === 'string' ? String(pick(args, ['description', 'about'])) : '';
    const isPrivate = pick(args, ['private', 'is_private']) === true;
    const created = createRepo(VIEWER.login, name, description, isPrivate);
    if ('error' in created) return toolResult({ error: created.error }, true);
    return toolResult(repoJson(created.repo));
  }

  if (tool.name === 'get_repo') {
    const owner = String(pick(args, ['owner', 'org', 'login']));
    const repoName = String(pick(args, ['repo', 'name', 'repository']));
    const repo = getRepo(owner, repoName);
    if (!repo) return toolResult({ error: 'Repository not found' }, true);
    return toolResult(repoJson(repo));
  }

  if (tool.name === 'create_issue') {
    const owner = String(pick(args, ['owner', 'org', 'login']));
    const repoName = String(pick(args, ['repo', 'name', 'repository']));
    const repo = getRepo(owner, repoName);
    if (!repo) return toolResult({ error: 'Repository not found' }, true);
    const title = String(pick(args, ['title', 'issue_title']));
    const body = typeof pick(args, ['body', 'description', 'text']) === 'string' ? String(pick(args, ['body', 'description', 'text'])) : '';
    const created = createIssue(repo, title, body, []);
    if ('error' in created) return toolResult({ error: created.error }, true);
    return toolResult(issueJson(repo, created.issue));
  }

  if (tool.name === 'list_issues') {
    const owner = String(pick(args, ['owner', 'org', 'login']));
    const repoName = String(pick(args, ['repo', 'name', 'repository']));
    const repo = getRepo(owner, repoName);
    if (!repo) return toolResult({ error: 'Repository not found' }, true);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const items = listIssues(repo, { state });
    return toolResult(items.map((i) => issueJson(repo, i)));
  }

  if (tool.name === 'create_pull_request') {
    const owner = String(pick(args, ['owner', 'org', 'login']));
    const repoName = String(pick(args, ['repo', 'name', 'repository']));
    const repo = getRepo(owner, repoName);
    if (!repo) return toolResult({ error: 'Repository not found' }, true);
    const title = String(pick(args, ['title']));
    const head = String(pick(args, ['head', 'head_branch', 'source']));
    const base = String(pick(args, ['base', 'base_branch', 'target']));
    const body = typeof pick(args, ['body', 'description', 'text']) === 'string' ? String(pick(args, ['body', 'description', 'text'])) : '';
    const created = createPR(repo, title, head, base, body);
    if ('error' in created) return toolResult({ error: created.error }, true);
    const pr = created.pr;
    return toolResult({
      id: pr.id,
      node_id: globalId('pr', `${repo.id}:${pr.number}`),
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      head: pr.head,
      base: pr.base,
      merged: pr.merged,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
    });
  }

  if (tool.name === 'merge_pull_request') {
    const owner = String(pick(args, ['owner', 'org', 'login']));
    const repoName = String(pick(args, ['repo', 'name', 'repository']));
    const repo = getRepo(owner, repoName);
    if (!repo) return toolResult({ error: 'Repository not found' }, true);
    const number = Number(pick(args, ['pull_number', 'number', 'pr_number']));
    const pr = repo.prs.get(number);
    if (!pr) return toolResult({ error: 'Pull request not found' }, true);
    const merged = mergePR(repo, number, 'squash');
    if ('error' in merged) return toolResult({ error: merged.error }, true);
    return toolResult({ merged: true, sha: merged.sha, message: merged.message, number });
  }

  return rpcError(-32602, `Unknown tool: ${toolName}`);
}
