// rest.ts — GitHub REST v3 under /api/v3.
//
// Contract (sdk/conformance/checks-rest.ts via rest-client.ts):
//   every reply application/json + non-empty X-GitHub-Request-Id
//   error body {"message": string}; unknown route 404; malformed JSON body 400
//   no token -> 401; repo under another owner -> 404 (never 403)

import {
  VIEWER,
  getCommit,
  getObject,
  getRepo,
  getRepoById,
  getTree,
  identIso,
  nowIso,
  parseIdent,
  reposOf,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import {
  addComment,
  createIssue,
  createPR,
  createRef,
  createRepo,
  deleteContents,
  deleteRepo,
  getContents,
  listBranches,
  listCommits,
  listIssues,
  mergePR,
  patchIssue,
  prFiles,
  prHasConflict,
  putContents,
} from './service.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter++;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Opaque, stable global ids (base64 of a typed key) shared with GraphQL. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function userJson(login: string): Record<string, unknown> {
  if (login === VIEWER.login) {
    return { login: VIEWER.login, id: VIEWER.id, avatar_url: '', type: 'User', site_admin: false };
  }
  return { login, id: 0, avatar_url: '', type: 'User', site_admin: false };
}

function repoJson(repo: Repo, origin: string): Record<string, unknown> {
  const openCount = [...repo.issues.values()].filter((i) => i.state === 'open').length + [...repo.prs.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('repo', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
    git_url: `${origin}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: '',
    language: null,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openCount,
    license: null,
    topics: [],
    allow_forking: true,
  };
}

function issueJson(repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: label?.id ?? 0, node_id: globalId('label', `${repo.id}:${name}`), name, color: label?.color ?? '000000', default: false, description: '' };
    }),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function prJson(repo: Repo, pr: PullRequest, origin: string): Record<string, unknown> {
  const conflict = pr.state === 'open' ? prHasConflict(repo, pr) : false;
  return {
    id: pr.id,
    node_id: globalId('pr', `${repo.id}:${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: userJson(pr.user),
    labels: [],
    head: { ref: pr.head.ref, sha: pr.head.sha, label: `${repo.owner}:${pr.head.ref}` },
    base: { ref: pr.base.ref, sha: pr.base.sha, label: `${repo.owner}:${pr.base.ref}` },
    merged: pr.merged,
    merge_commit_sha: pr.merge_commit_sha,
    merged_at: pr.merged_at,
    mergeable: !conflict,
    mergeable_state: conflict ? 'dirty' : 'clean',
    draft: false,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.state === 'closed' ? pr.updated_at : null,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function commentJson(repo: Repo, kind: string, number: number, comment: { id: number; body: string; user: string; created_at: string; updated_at: string }, origin: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('comment', `${repo.id}:${kind}:${number}:${comment.id}`),
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments/${comment.id}`,
  };
}

function commitJson(repo: Repo, sha: string, origin: string): Record<string, unknown> | null {
  const commit = getCommit(repo, sha);
  if (!commit) return null;
  const authorIdent = parseIdent(commit.author);
  const committerIdent = parseIdent(commit.committer);
  const authorLogin = authorIdent.email === VIEWER.email ? userJson(VIEWER.login) : null;
  const committerLogin = committerIdent.email === VIEWER.email ? userJson(VIEWER.login) : null;
  return {
    sha,
    node_id: globalId('commit', `${repo.id}:${sha}`),
    commit: {
      author: { name: authorIdent.name, email: authorIdent.email, date: identIso(commit.author) },
      committer: { name: committerIdent.name, email: committerIdent.email, date: identIso(commit.committer) },
      message: commit.message,
      tree: { sha: commit.tree },
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/commit/${sha}`,
    author: authorLogin,
    committer: committerLogin,
    parents: commit.parents.map((p) => ({ sha: p })),
  };
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; link: string | null; totalPages: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), link: null, totalPages };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, page: number, totalPages: number): string | null {
  if (totalPages <= 1) return null;
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    return `<${origin}${path}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (page > 1) {
    parts.push(`${build(1)}; rel="first"`);
    parts.push(`${build(page - 1)}; rel="prev"`);
  }
  if (page < totalPages) {
    parts.push(`${build(page + 1)}; rel="next"`);
    parts.push(`${build(totalPages)}; rel="last"`);
  }
  return parts.length ? parts.join(', ') : null;
}

interface Ctx {
  method: string;
  parts: string[];
  query: URLSearchParams;
  body: unknown;
  origin: string;
  authed: boolean;
}

/** Route one REST call. `parts` are the path segments after /api/v3. */
export function handleRest(ctx: Ctx): RestResult {
  const { method, parts } = ctx;
  if (!ctx.authed) return err(401, 'Requires authentication');

  // GET /api/v3/ (root)
  if (parts.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: `${ctx.origin}/api/v3/user` }, { 'X-OAuth-Scopes': 'repo, user' });
  }

  if (parts[0] === 'meta' && parts.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0' });
  }

  if (parts[0] === 'user' && parts.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { ...userJson(VIEWER.login), name: VIEWER.name, email: VIEWER.email });
  }

  if (parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'POST') {
      const b = (ctx.body ?? {}) as Record<string, unknown>;
      if (typeof b.name !== 'string' || b.name === '') return err(422, 'Validation Failed: name is required');
      const result = createRepo(VIEWER.login, b.name, typeof b.description === 'string' ? b.description : '', b.private === true);
      if ('error' in result) return err(422, 'Validation Failed: name already exists on this account');
      return ok(201, repoJson(result.repo, ctx.origin));
    }
    if (method === 'GET') {
      const all = reposOf(VIEWER.login);
      const { page, totalPages } = paginate(all, ctx.query);
      const pageNum = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
      const link = linkHeader(ctx.origin, '/api/v3/user/repos', ctx.query, pageNum, totalPages);
      return ok(200, page.map((r) => repoJson(r, ctx.origin)), link ? { Link: link } : undefined);
    }
    return err(404, 'Not Found');
  }

  if (parts[0] === 'repos' && parts.length >= 3) {
    const owner = decodeURIComponent(parts[1]!);
    const name = decodeURIComponent(parts[2]!);
    const repo = getRepo(owner, name);
    if (!repo) return err(404, 'Not Found');
    const rest = parts.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(repo, ctx.origin));
      if (method === 'PATCH') {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.private = b.private;
        repo.updated_at = nowIso();
        return ok(200, repoJson(repo, ctx.origin));
      }
      if (method === 'DELETE') {
        deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b.ref !== 'string' || typeof b.sha !== 'string') return err(422, 'Validation Failed: ref and sha are required');
        const r = createRef(repo, b.ref, b.sha);
        if (!r.ok) return err(422, r.error ?? 'Validation Failed');
        return ok(201, { ref: b.ref, node_id: globalId('ref', `${repo.id}:${b.ref}`), object: { sha: b.sha, type: 'commit' } });
      }
      if (method === 'GET' && rest.length >= 3) {
        const refName = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
        const sha = repo.refs.get(refName);
        if (!sha) return err(404, 'Not Found');
        return ok(200, { ref: refName, node_id: globalId('ref', `${repo.id}:${refName}`), object: { sha, type: 'commit' } });
      }
      return err(404, 'Not Found');
    }

    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        return ok(200, listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha }, protected: false })));
      }
      if (method === 'GET' && rest.length === 2) {
        const branch = decodeURIComponent(rest[1]!);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return err(404, 'Not Found');
        return ok(200, { name: branch, commit: { sha }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shas = listCommits(repo, ctx.query.get('sha') ?? undefined);
      const out: unknown[] = [];
      for (const sha of shas) {
        const c = commitJson(repo, sha, ctx.origin);
        if (c) out.push(c);
      }
      return ok(200, out);
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'GET') {
        const result = getContents(repo, path, ctx.query.get('ref') ?? undefined);
        if ('error' in result) return err(404, 'Not Found');
        if (result.kind === 'file') {
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: result.data.length,
            name: path.split('/').pop() ?? '',
            path,
            content: result.data.toString('base64'),
            sha: result.blobSha,
            url: `${ctx.origin}/api/v3/repos/${owner}/${name}/contents/${path}`,
            html_url: `${ctx.origin}/${owner}/${name}/blob/main/${path}`,
            git_url: `${ctx.origin}/api/v3/repos/${owner}/${name}/git/blobs/${result.blobSha}`,
            download_url: `${ctx.origin}/${owner}/${name}/raw/main/${path}`,
          });
        }
        return ok(200, result.entries.map((e) => ({
          type: e.type,
          size: e.size,
          name: e.name,
          path: e.path,
          sha: e.sha,
          url: `${ctx.origin}/api/v3/repos/${owner}/${name}/contents/${e.path}`,
          html_url: `${ctx.origin}/${owner}/${name}/blob/main/${e.path}`,
          git_url: `${ctx.origin}/api/v3/repos/${owner}/${name}/git/blobs/${e.sha}`,
          download_url: e.type === 'file' ? `${ctx.origin}/${owner}/${name}/raw/main/${e.path}` : null,
        })));
      }
      if (method === 'PUT') {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b.content !== 'string' || typeof b.message !== 'string') return err(422, 'Validation Failed: content and message are required');
        const result = putContents(repo, path, b.content, b.message, typeof b.sha === 'string' ? b.sha : undefined, typeof b.branch === 'string' ? b.branch : undefined);
        if ('error' in result) return err(result.status, result.error);
        const commit = getCommit(repo, result.commitSha);
        return ok(result.created ? 201 : 200, {
          content: { name: path.split('/').pop() ?? '', path, sha: result.blobSha, size: Buffer.from(b.content.replace(/[\r\n\t ]+/g, ''), 'base64').length, encoding: 'base64' },
          commit: { sha: result.commitSha, message: b.message, author: { name: VIEWER.name, email: VIEWER.email, date: commit ? identIso(commit.author) : nowIso() } },
        });
      }
      if (method === 'DELETE') {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b.sha !== 'string' || typeof b.message !== 'string') return err(422, 'Validation Failed: sha and message are required');
        const result = deleteContents(repo, path, b.message, b.sha, typeof b.branch === 'string' ? b.branch : undefined);
        if ('error' in result) return err(result.status, result.error);
        return ok(200, { commit: { sha: result.commitSha, message: b.message } });
      }
      return err(404, 'Not Found');
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return ok(200, [...repo.labels.values()].map((l) => ({ id: l.id, node_id: globalId('label', `${repo.id}:${l.name}`), name: l.name, color: l.color, default: false, description: '' })));
      }
      if (method === 'POST' && rest.length === 1) {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b.name !== 'string' || b.name === '') return err(422, 'Validation Failed: name is required');
        if (repo.labels.has(b.name)) return err(422, 'Validation Failed: label already exists');
        const label = { id: repo.nextLabelId++, name: b.name, color: typeof b.color === 'string' ? b.color.replace(/^#/, '') : '000000' };
        repo.labels.set(b.name, label);
        return ok(201, { id: label.id, node_id: globalId('label', `${repo.id}:${label.name}`), name: label.name, color: label.color, default: false, description: '' });
      }
      return err(404, 'Not Found');
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const b = (ctx.body ?? {}) as Record<string, unknown>;
          if (typeof b.title !== 'string' || b.title === '') return err(422, 'Validation Failed: title is required');
          const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
          const result = createIssue(repo, b.title, typeof b.body === 'string' ? b.body : '', labels);
          if ('error' in result) return err(422, result.error);
          return ok(201, issueJson(repo, result.issue, ctx.origin));
        }
        if (method === 'GET') {
          const items = listIssues(repo, {
            state: ctx.query.get('state') ?? undefined,
            sort: ctx.query.get('sort') ?? undefined,
            direction: ctx.query.get('direction') ?? undefined,
          });
          const { page, totalPages } = paginate(items, ctx.query);
          const pageNum = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
          const link = linkHeader(ctx.origin, `/api/v3/repos/${owner}/${name}/issues`, ctx.query, pageNum, totalPages);
          return ok(200, page.map((i) => issueJson(repo, i, ctx.origin)), link ? { Link: link } : undefined);
        }
        return err(404, 'Not Found');
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num) || num <= 0) return err(404, 'Not Found');
      if (rest.length === 2) {
        const issue = repo.issues.get(num);
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueJson(repo, issue, ctx.origin));
        if (method === 'PATCH') {
          const b = (ctx.body ?? {}) as Record<string, unknown>;
          const patch: { state?: string; title?: string; body?: string } = {};
          if (typeof b.state === 'string') patch.state = b.state;
          if (typeof b.title === 'string') patch.title = b.title;
          if (typeof b.body === 'string') patch.body = b.body;
          const updated = patchIssue(repo, num, patch);
          if (!updated) return err(404, 'Not Found');
          return ok(200, issueJson(repo, updated, ctx.origin));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        const issue = repo.issues.get(num);
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') {
          return ok(200, issue.comments.map((c) => commentJson(repo, 'issue', num, c, ctx.origin)));
        }
        if (method === 'POST') {
          const b = (ctx.body ?? {}) as Record<string, unknown>;
          if (typeof b.body !== 'string' || b.body === '') return err(422, 'Validation Failed: body is required');
          const comment = addComment(repo, 'issue', num, b.body);
          if (!comment) return err(404, 'Not Found');
          return ok(201, commentJson(repo, 'issue', num, comment, ctx.origin));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const b = (ctx.body ?? {}) as Record<string, unknown>;
          if (typeof b.title !== 'string' || typeof b.head !== 'string' || typeof b.base !== 'string') {
            return err(422, 'Validation Failed: title, head and base are required');
          }
          const result = createPR(repo, b.title, b.head, b.base, typeof b.body === 'string' ? b.body : '');
          if ('error' in result) return err(422, result.error);
          return ok(201, prJson(repo, result.pr, ctx.origin));
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let items = [...repo.prs.values()];
          if (state !== 'all') items = items.filter((p) => p.state === state);
          items.sort((a, b) => b.number - a.number);
          const { page, totalPages } = paginate(items, ctx.query);
          const pageNum = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
          const link = linkHeader(ctx.origin, `/api/v3/repos/${owner}/${name}/pulls`, ctx.query, pageNum, totalPages);
          return ok(200, page.map((p) => prJson(repo, p, ctx.origin)), link ? { Link: link } : undefined);
        }
        return err(404, 'Not Found');
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num) || num <= 0) return err(404, 'Not Found');
      const pr = repo.prs.get(num);
      if (rest.length === 2) {
        if (!pr) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, prJson(repo, pr, ctx.origin));
        return err(404, 'Not Found');
      }
      if (rest[2] === 'files' && method === 'GET') {
        if (!pr) return err(404, 'Not Found');
        return ok(200, prFiles(repo, pr).map((f) => ({
          sha: '',
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        })));
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        if (!pr) return err(404, 'Not Found');
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const methodName = typeof b.merge_method === 'string' ? b.merge_method : 'squash';
        if (pr.state !== 'open') return err(405, 'Pull request is already closed');
        if (prHasConflict(repo, pr)) return err(405, 'Merge conflict');
        const result = mergePR(repo, num, methodName);
        if ('error' in result) return err(405, result.error);
        return ok(200, { merged: true, sha: result.sha, message: result.message });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

export { getRepoById, getTree, getObject };
