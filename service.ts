// service.ts — domain operations shared by the REST, GraphQL and MCP surfaces.
// Every mutation goes through here so the three surfaces act on one store and agree.

import {
  VIEWER,
  buildCommit,
  collectReachableBounded,
  diffBlobLines,
  flattenTree,
  getCommit,
  getObject,
  getRepo,
  getTree,
  hashObject,
  isAncestor,
  newRepo,
  nowIso,
  putObject,
  repoKey,
  repos,
  updatePathInTree,
  viewerIdent,
  walkCommits,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

export function createRepo(
  owner: string,
  name: string,
  description: string,
  isPrivate: boolean,
): { repo: Repo } | { error: string } {
  if (getRepo(owner, name)) return { error: 'already exists' };
  const repo = newRepo(owner, name, description, isPrivate);
  return { repo };
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function createIssue(
  repo: Repo,
  title: string,
  body: string,
  labels: string[],
): { issue: Issue } | { error: string } {
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: `unknown label: ${label}` };
  }
  const number = repo.nextNumber++;
  const now = nowIso();
  const issue: Issue = {
    id: repo.id * 100000 + number,
    number,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    created_at: now,
    updated_at: now,
    closed_at: null,
    user: VIEWER.login,
  };
  repo.issues.set(number, issue);
  repo.updated_at = now;
  return { issue };
}

export function listIssues(
  repo: Repo,
  opts: { state?: string; sort?: string; direction?: string },
): Issue[] {
  let items = [...repo.issues.values()];
  const state = opts.state ?? 'open';
  if (state !== 'all') items = items.filter((i) => i.state === state);
  const dir = opts.direction === 'asc' ? 1 : -1;
  items.sort((a, b) => (a.number - b.number) * dir);
  return items;
}

export function patchIssue(
  repo: Repo,
  number: number,
  patch: { state?: string; title?: string; body?: string },
): Issue | undefined {
  const issue = repo.issues.get(number);
  if (!issue) return undefined;
  if (patch.title !== undefined) issue.title = patch.title;
  if (patch.body !== undefined) issue.body = patch.body;
  if (patch.state === 'closed' || patch.state === 'open') {
    issue.state = patch.state;
    issue.closed_at = patch.state === 'closed' ? nowIso() : null;
  }
  issue.updated_at = nowIso();
  return issue;
}

export function addComment(repo: Repo, kind: 'issue' | 'pr', number: number, body: string) {
  const target = kind === 'issue' ? repo.issues.get(number) : repo.prs.get(number);
  if (!target) return undefined;
  const now = nowIso();
  const comment = {
    id: repo.id * 1000000 + repo.nextCommentId++,
    body,
    user: VIEWER.login,
    created_at: now,
    updated_at: now,
  };
  target.comments.push(comment);
  return comment;
}

export function createPR(
  repo: Repo,
  title: string,
  head: string,
  base: string,
  body: string,
): { pr: PullRequest } | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha) return { error: `head branch not found: ${head}` };
  if (!baseSha) return { error: `base branch not found: ${base}` };
  const number = repo.nextNumber++;
  const now = nowIso();
  const pr: PullRequest = {
    id: repo.id * 100000 + number,
    number,
    title,
    body,
    state: 'open',
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
    merged: false,
    merge_commit_sha: null,
    merged_at: null,
    comments: [],
    created_at: now,
    updated_at: now,
    user: VIEWER.login,
  };
  repo.prs.set(number, pr);
  repo.updated_at = now;
  return { pr };
}

export interface MergeBaseInfo {
  base: string;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
}

/** The merge base of two commits: the first common ancestor found walking head's history. */
export function mergeBase(repo: Repo, headSha: string, baseSha: string): string | null {
  const baseAncestors = new Set(walkCommits(repo, baseSha));
  const queue = [headSha];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.pop()!;
    if (baseAncestors.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

/** A PR's head/base tips, resolved live from the branch refs (GitHub tracks the branch,
 * not the sha at creation: a push after the PR is opened moves the PR's tip). */
export function currentPrTips(repo: Repo, pr: PullRequest): { headSha: string; baseSha: string } {
  const headSha = repo.refs.get(`refs/heads/${pr.head.ref}`) ?? pr.head.sha;
  const baseSha = repo.refs.get(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
  pr.head.sha = headSha;
  pr.base.sha = baseSha;
  return { headSha, baseSha };
}

/** Files changed between the merge base and head, with line counts. */
export function prFiles(repo: Repo, pr: PullRequest): MergeBaseInfo['files'] {
  const { headSha, baseSha } = currentPrTips(repo, pr);
  const base = mergeBase(repo, headSha, baseSha);
  const headCommit = getCommit(repo, headSha);
  const baseTree = base ? getCommit(repo, base)?.tree ?? null : null;
  const headTree = headCommit?.tree ?? null;
  const baseFiles = baseTree ? flattenTree(repo, baseTree) : new Map();
  const headFiles = headTree ? flattenTree(repo, headTree) : new Map();
  const out: MergeBaseInfo['files'] = [];
  const names = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const name of [...names].sort()) {
    const b = baseFiles.get(name);
    const h = headFiles.get(name);
    if (b && !h) {
      const oldData = getObject(repo, b.oid)?.data ?? null;
      const d = diffBlobLines(oldData, null);
      out.push({ filename: name, status: 'removed', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    } else if (!b && h) {
      const newData = getObject(repo, h.oid)?.data ?? null;
      const d = diffBlobLines(null, newData);
      out.push({ filename: name, status: 'added', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    } else if (b && h && b.oid !== h.oid) {
      const oldData = getObject(repo, b.oid)?.data ?? null;
      const newData = getObject(repo, h.oid)?.data ?? null;
      const d = diffBlobLines(oldData, newData);
      out.push({ filename: name, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  return out;
}

/** True when head and base both changed the same path since the merge base. */
export function prHasConflict(repo: Repo, pr: PullRequest): boolean {
  const { headSha, baseSha } = currentPrTips(repo, pr);
  const base = mergeBase(repo, headSha, baseSha);
  if (!base) return false;
  const baseTree = getCommit(repo, base)?.tree ?? null;
  const headTree = getCommit(repo, headSha)?.tree ?? null;
  const baseBranchTree = getCommit(repo, baseSha)?.tree ?? null;
  const mb = baseTree ? flattenTree(repo, baseTree) : new Map();
  const hf = headTree ? flattenTree(repo, headTree) : new Map();
  const bf = baseBranchTree ? flattenTree(repo, baseBranchTree) : new Map();
  const names = new Set([...mb.keys(), ...hf.keys(), ...bf.keys()]);
  for (const name of names) {
    const m = mb.get(name)?.oid ?? null;
    const h = hf.get(name)?.oid ?? null;
    const b = bf.get(name)?.oid ?? null;
    if (h !== m && b !== m && h !== b) return true;
  }
  return false;
}

/** Squash-merge a PR: one commit on the base branch with the head's tree content. */
export function mergePR(
  repo: Repo,
  number: number,
  method: string,
): { pr: PullRequest; sha: string; message: string } | { error: string } {
  const pr = repo.prs.get(number);
  if (!pr) return { error: 'not found' };
  if (pr.state !== 'open') return { error: 'already closed' };
  if (prHasConflict(repo, pr)) return { error: 'conflict' };
  const { headSha, baseSha: baseTip } = currentPrTips(repo, pr);
  const baseSha = mergeBase(repo, headSha, baseTip);
  const baseTree = baseSha ? getCommit(repo, baseSha)?.tree ?? null : null;
  const headTree = getCommit(repo, headSha)?.tree ?? null;
  const baseBranchTree = getCommit(repo, baseTip)?.tree ?? null;
  // Merged tree: base branch's tree with head's changes since the merge base applied.
  const mb = baseTree ? flattenTree(repo, baseTree) : new Map();
  const hf = headTree ? flattenTree(repo, headTree) : new Map();
  const bf = baseBranchTree ? flattenTree(repo, baseBranchTree) : new Map();
  let mergedTree = baseBranchTree;
  const names = new Set([...mb.keys(), ...hf.keys()]);
  for (const name of names) {
    const m = mb.get(name)?.oid ?? null;
    const h = hf.get(name)?.oid ?? null;
    if (h !== m) {
      const parts = name.split('/');
      if (mergedTree === null) mergedTree = putObject(repo, 'tree', Buffer.alloc(0));
      if (h === null) {
        mergedTree = updatePathInTree(repo, mergedTree, parts, null);
      } else {
        mergedTree = updatePathInTree(repo, mergedTree, parts, h);
      }
    }
  }
  void bf;
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `${pr.title} (#${pr.number})\n`;
  const commitData = buildCommit({
    tree: mergedTree ?? putObject(repo, 'tree', Buffer.alloc(0)),
    parents: [pr.base.sha],
    message,
    author: viewerIdent(),
    committer: viewerIdent(),
    timestamp,
  });
  const sha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pr.base.ref}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.merge_commit_sha = sha;
  pr.merged_at = nowIso();
  pr.updated_at = nowIso();
  repo.updated_at = nowIso();
  void method;
  return { pr, sha, message: message.trim() };
}

export function createRef(repo: Repo, ref: string, sha: string): { ok: boolean; error?: string } {
  if (repo.refs.has(ref)) return { ok: false, error: 'already exists' };
  if (!getObject(repo, sha)) return { ok: false, error: 'object not found' };
  repo.refs.set(ref, sha);
  return { ok: true };
}

export function listBranches(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

export function listCommits(repo: Repo, sha?: string): string[] {
  let tip = sha;
  if (!tip) tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (!tip) {
    const first = [...repo.refs.values()][0];
    tip = first;
  }
  if (!tip) return [];
  // `sha` may be a branch name or a ref.
  if (!/^[0-9a-f]{40}$/.test(tip)) {
    tip = repo.refs.get(`refs/heads/${tip}`) ?? repo.refs.get(tip) ?? tip;
  }
  if (!tip || !/^[0-9a-f]{40}$/.test(tip)) return [];
  return walkCommits(repo, tip);
}

/**
 * PUT /contents: create or update a file, making real git objects. Returns the blob sha
 * and the new commit sha. `expectedSha` (for updates) must match the current blob.
 */
export function putContents(
  repo: Repo,
  path: string,
  contentB64: string,
  message: string,
  expectedSha: string | undefined,
  branch: string | undefined,
): { blobSha: string; commitSha: string; created: boolean } | { error: string; status: number } {
  const branchName = branch ?? repo.default_branch;
  const ref = `refs/heads/${branchName}`;
  const tip = repo.refs.get(ref);
  const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobSha = putObject(repo, 'blob', content);
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0) return { error: 'empty path', status: 400 };
  let baseTree: string | null = null;
  let created = true;
  if (tip) {
    const commit = getCommit(repo, tip);
    baseTree = commit?.tree ?? null;
    if (baseTree) {
      const flat = flattenTree(repo, baseTree);
      const existing = flat.get(path);
      if (existing) {
        created = false;
        if (expectedSha !== undefined && expectedSha !== existing.oid) {
          return { error: 'sha does not match', status: 409 };
        }
      } else if (expectedSha !== undefined) {
        return { error: 'file does not exist', status: 422 };
      }
    }
  }
  const newTree = updatePathInTree(repo, baseTree, parts, blobSha);
  const timestamp = Math.floor(Date.now() / 1000);
  const commitData = buildCommit({
    tree: newTree,
    parents: tip ? [tip] : [],
    message,
    author: viewerIdent(),
    committer: viewerIdent(),
    timestamp,
  });
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  repo.updated_at = nowIso();
  return { blobSha, commitSha, created };
}

/** DELETE /contents: remove a file, making a real commit. */
export function deleteContents(
  repo: Repo,
  path: string,
  message: string,
  expectedSha: string,
  branch: string | undefined,
): { commitSha: string } | { error: string; status: number } {
  const branchName = branch ?? repo.default_branch;
  const ref = `refs/heads/${branchName}`;
  const tip = repo.refs.get(ref);
  if (!tip) return { error: 'not found', status: 404 };
  const commit = getCommit(repo, tip);
  if (!commit) return { error: 'not found', status: 404 };
  const flat = flattenTree(repo, commit.tree);
  const existing = flat.get(path);
  if (!existing) return { error: 'not found', status: 404 };
  if (expectedSha !== existing.oid) return { error: 'sha does not match', status: 409 };
  const parts = path.split('/').filter((p) => p !== '');
  const newTree = updatePathInTree(repo, commit.tree, parts, null);
  const timestamp = Math.floor(Date.now() / 1000);
  const commitData = buildCommit({
    tree: newTree,
    parents: [tip],
    message,
    author: viewerIdent(),
    committer: viewerIdent(),
    timestamp,
  });
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  repo.updated_at = nowIso();
  return { commitSha };
}

/** Read a file or directory at a ref's tip tree. */
export function getContents(
  repo: Repo,
  path: string,
  ref: string | undefined,
):
  | { kind: 'file'; blobSha: string; data: Buffer }
  | { kind: 'dir'; entries: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> }
  | { error: string } {
  let tip = ref;
  if (tip) {
    if (!/^[0-9a-f]{40}$/.test(tip)) {
      tip = repo.refs.get(`refs/heads/${tip}`) ?? repo.refs.get(tip);
    }
  } else {
    tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
  }
  if (!tip) return { error: 'not found' };
  const commit = getCommit(repo, tip);
  if (!commit) return { error: 'not found' };
  const flat = flattenTree(repo, commit.tree);
  if (path === '') {
    const entries: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> = [];
    const top = getTree(repo, commit.tree) ?? [];
    for (const entry of top) {
      const isDir = entry.mode === '40000';
      const size = isDir ? 0 : getObject(repo, entry.oid)?.data.length ?? 0;
      entries.push({ name: entry.name, path: entry.name, sha: entry.oid, type: isDir ? 'dir' : 'file', size });
    }
    return { kind: 'dir', entries };
  }
  const file = flat.get(path);
  if (file) {
    const data = getObject(repo, file.oid)?.data;
    if (!data) return { error: 'not found' };
    return { kind: 'file', blobSha: file.oid, data };
  }
  // Maybe a directory: find a tree at this path.
  const parts = path.split('/');
  let treeSha: string | null = commit.tree;
  for (const part of parts) {
    if (!treeSha) break;
    const entries = getTree(repo, treeSha) ?? [];
    const found = entries.find((e) => e.name === part);
    if (!found || found.mode !== '40000') {
      treeSha = null;
      break;
    }
    treeSha = found.oid;
  }
  if (treeSha) {
    const entries: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> = [];
    for (const entry of getTree(repo, treeSha) ?? []) {
      const isDir = entry.mode === '40000';
      const size = isDir ? 0 : getObject(repo, entry.oid)?.data.length ?? 0;
      entries.push({ name: entry.name, path: `${path}/${entry.name}`, sha: entry.oid, type: isDir ? 'dir' : 'file', size });
    }
    return { kind: 'dir', entries };
  }
  return { error: 'not found' };
}

/** The git object ids reachable from a set of tips, minus those reachable from `haves`. */
export function objectsForFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  shallowBoundaries: string[],
): { objects: Array<{ type: import('./store.ts').GitObjectType; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  // A want may name a tag object: the tag itself ships, and its target is fetched as a want.
  const seedObjects = new Set<string>();
  const commitWants: string[] = [];
  for (const want of wants) {
    const obj = getObject(repo, want);
    if (!obj) continue;
    if (obj.type === 'commit') {
      commitWants.push(want);
    } else if (obj.type === 'tag') {
      seedObjects.add(want);
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) {
        const target = getObject(repo, m[1]!);
        if (target?.type === 'commit') commitWants.push(m[1]!);
        else seedObjects.add(m[1]!);
      }
    } else {
      seedObjects.add(want);
    }
  }
  // What the client already has: reachable from its haves, but never past its shallow
  // boundaries (a shallow holder has the boundary commit, not its history).
  const haveReachable = collectReachableBounded(repo, haves, new Set(shallowBoundaries));
  // Walk from wants, cutting off at the depth boundary.
  const included = new Set<string>();
  const shallow = new Set<string>();
  const queue: Array<{ oid: string; level: number }> = commitWants.map((oid) => ({ oid, level: 0 }));
  const seenCommits = new Set<string>();
  while (queue.length) {
    const { oid, level } = queue.pop()!;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    included.add(oid);
    const isBoundary = shallowBoundaries.includes(oid);
    if (depth !== undefined && level + 1 >= depth) {
      shallow.add(oid);
      continue;
    }
    if (depth === undefined && isBoundary) {
      shallow.add(oid);
      continue;
    }
    for (const parent of commit.parents) queue.push({ oid: parent, level: level + 1 });
  }
  const unshallow: string[] = [];
  for (const b of shallowBoundaries) {
    if (included.has(b) && !shallow.has(b)) unshallow.push(b);
  }
  // Objects for the pack: walk from the included commits, but never descend past a
  // commit that is NOT in `included` (a shallow boundary or a depth cut-off). A plain
  // reachability walk would follow every parent and leak the hidden history.
  const reachable = new Set<string>();
  const stack = [...included, ...seedObjects];
  while (stack.length) {
    const oid = stack.pop()!;
    if (reachable.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj) continue;
    reachable.add(oid);
    if (obj.type === 'commit') {
      const commit = getCommit(repo, oid);
      if (!commit) continue;
      stack.push(commit.tree);
      for (const parent of commit.parents) {
        if (included.has(parent)) stack.push(parent);
      }
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) stack.push(m[1]!);
    } else if (obj.type === 'tree') {
      for (const entry of getTree(repo, oid) ?? []) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  const objects: Array<{ type: import('./store.ts').GitObjectType; data: Buffer }> = [];
  for (const oid of reachable) {
    if (haveReachable.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow: [...shallow], unshallow };
}

export { hashObject };
