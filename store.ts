// store.ts — the forge's in-memory store and git object model.
//
// Everything the entry holds lives here: repositories, issues, pull requests, labels,
// comments, refs, and the git object store (SHA-1, zlib, packfiles). No filesystem, no
// network, no git binary. The server is one process; this module is its only state.
//
// The viewer is the sealed scenario's token owner (wire.ts buildScenario): login
// "adaiversen", id 1000. The bearer token is opaque; ownership is always the viewer.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);

/** The token owner, per the sealed scenario (wire.ts). */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export interface CommentItem {
  id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentItem[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  user: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merge_commit_sha: string | null;
  merged_at: string | null;
  comments: CommentItem[];
  created_at: string;
  updated_at: string;
  user: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  issues: Map<number, Issue>;
  prs: Map<number, PullRequest>;
  nextNumber: number;
  nextCommentId: number;
  nextLabelId: number;
  labels: Map<string, Label>;
  refs: Map<string, string>;
  objects: Map<string, { type: GitObjectType; data: Buffer }>;
  commitCache: Map<string, CommitView>;
  treeCache: Map<string, TreeEntry[]>;
}

/** All repositories, keyed `${owner}/${name}`. */
export const repos = new Map<string, Repo>();
let nextRepoId = 1;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const now = nowIso();
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner,
    description,
    private: isPrivate,
    default_branch: 'main',
    created_at: now,
    updated_at: now,
    issues: new Map(),
    prs: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    nextLabelId: 1,
    labels: new Map(),
    refs: new Map(),
    objects: new Map(),
    commitCache: new Map(),
    treeCache: new Map(),
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function getRepoById(id: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return undefined;
}

export function reposOf(owner: string): Repo[] {
  const out: Repo[] = [];
  for (const repo of repos.values()) if (repo.owner === owner) out.push(repo);
  return out;
}

// ---------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): { type: GitObjectType; data: Buffer } | undefined {
  return repo.objects.get(oid);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(opts: {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const who = `${opts.author} ${opts.timestamp} +0000`;
  const lines = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${opts.committer} ${opts.timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${opts.message}`, 'utf8');
}

/** Parse "Name <email> 1700000000 +0000" into its parts. */
export function parseIdent(line: string): { name: string; email: string; timestamp: number; tz: string } {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) return { name: line, email: '', timestamp: 0, tz: '+0000' };
  return { name: m[1] ?? '', email: m[2] ?? '', timestamp: Number(m[3] ?? 0), tz: m[4] ?? '+0000' };
}

export function identIso(line: string): string {
  const ident = parseIdent(line);
  if (!ident.timestamp) return nowIso();
  return new Date(ident.timestamp * 1000).toISOString();
}

export function viewerIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

export function getCommit(repo: Repo, oid: string): CommitView | undefined {
  const cached = repo.commitCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return undefined;
  const parsed = parseCommit(obj.data);
  repo.commitCache.set(oid, parsed);
  return parsed;
}

export function getTree(repo: Repo, oid: string): TreeEntry[] | undefined {
  const cached = repo.treeCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tree') return undefined;
  const parsed = parseTree(obj.data);
  repo.treeCache.set(oid, parsed);
  return parsed;
}

/** Every object reachable from `roots`, except that parents of a commit in `stopAt` are
 * not followed (a shallow boundary: the holder has the commit but not its history). */
export function collectReachableBounded(repo: Repo, roots: Iterable<string>, stopAt: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (root !== ZERO_OID && /^[0-9a-f]{40}$/.test(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      if (!stopAt.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) queue.push(m[1]!);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}
export function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (root !== ZERO_OID && /^[0-9a-f]{40}$/.test(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) queue.push(m[1]!);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (or equal). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return false;
}

/** Walk commits from `tip` in newest-first (DFS pre-order) order. */
export function walkCommits(repo: Repo, tip: string, limit = 10000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length && out.length < limit) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    out.push(oid);
    for (let i = commit.parents.length - 1; i >= 0; i--) queue.push(commit.parents[i]!);
  }
  return out;
}

/** Flatten a tree to path -> {mode, oid} (files and gitlinks only; dirs expanded). */
export function flattenTree(repo: Repo, treeSha: string): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (sha: string, prefix: string): void => {
    const entries = getTree(repo, sha);
    if (!entries) return;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeSha, '');
  return out;
}

/**
 * Return the new tree sha after setting (or deleting, when blobSha is null) `parts` in the
 * tree rooted at `baseTreeSha` (null = empty tree). Rebuilds trees bottom-up.
 */
export function updatePathInTree(
  repo: Repo,
  baseTreeSha: string | null,
  parts: string[],
  blobSha: string | null,
): string {
  const update = (treeSha: string | null, depth: number): string | null => {
    const entries = treeSha ? [...(getTree(repo, treeSha) ?? [])] : [];
    const name = parts[depth]!;
    const idx = entries.findIndex((e) => e.name === name);
    if (depth === parts.length - 1) {
      if (blobSha === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '100644', name, oid: blobSha };
      } else {
        entries.push({ mode: '100644', name, oid: blobSha });
      }
    } else {
      const childSha = idx >= 0 && entries[idx]!.mode === '40000' ? entries[idx]!.oid : null;
      const newChild = update(childSha, depth + 1);
      if (newChild === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '40000', name, oid: newChild };
      } else {
        entries.push({ mode: '40000', name, oid: newChild });
      }
    }
    if (entries.length === 0) return null;
    return putObject(repo, 'tree', buildTree(entries));
  };
  const result = update(baseTreeSha, 0);
  if (result === null) {
    // An empty tree object (git's well-known empty tree).
    return putObject(repo, 'tree', Buffer.alloc(0));
  }
  return result;
}

/** A line-count diff between two blobs: {additions, deletions}. */
export function diffBlobLines(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  if (oldData !== null && oldData.length > 0 && oldData[oldData.length - 1] === 0x0a) oldLines.pop();
  if (newData !== null && newData.length > 0 && newData[newData.length - 1] === 0x0a) newLines.pop();
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). */
export function writePack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackReadEntry {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

/**
 * Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA against the pack itself and,
 * for thin packs, against `resolveBase`. Throws on any corruption.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => { type: GitObjectType; data: Buffer } | undefined,
): PackReadEntry[] {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = sha1Hex(pack.subarray(0, trailerStart));
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < declaredCount; i++) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack trailing bytes');

  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _r?: { type: GitObjectType; data: Buffer; oid: string } })._r;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as unknown as { _r: unknown })._r = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };

  const out: PackReadEntry[] = [];
  for (const entry of raw) {
    const r = resolve(entry);
    out.push({ type: r.type, data: r.data, oid: r.oid });
  }
  return out;
}
