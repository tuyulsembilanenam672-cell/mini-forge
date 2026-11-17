// git.ts — git smart HTTP: protocol v2 upload-pack, v0 upload-pack, v0 receive-pack.
//
// Wire contract (from sdk/conformance/git-client.ts, the sealed client):
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /{owner}/{repo}.git/git-upload-pack     (v2 when Git-Protocol: version=2)
//   POST /{owner}/{repo}.git/git-receive-pack    (v0 only)
// Pkt-lines: 4 hex length + payload; 0000 flush, 0001 delim, 0002 response-end.
// Sideband: pkt-line payload starts with a band byte (1 data, 2 progress, 3 error).

import {
  ZERO_OID,
  getCommit,
  getObject,
  getRepo,
  isAncestor,
  putObject,
  readPack,
  writePack,
  type GitObjectType,
  type Repo,
} from './store.ts';
import { objectsForFetch } from './service.ts';

export const AGENT = 'github-core-clone/1.0';

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = Buffer.from('0000', 'ascii');
export const pktDelim = Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode pkt-lines from the start of `buf`; returns packets and bytes consumed.
 * With `stopAfterFlush`, stops after the first flush packet (a receive-pack command
 * list ends there; raw pack bytes follow and are not pkt-lines). */
export function decodePktLines(buf: Buffer, opts: { stopAfterFlush?: boolean } = {}): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (opts.stopAfterFlush) break;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len === 3 || len > 65520) throw new Error(`bad pkt-line length ${len}`);
    if (offset + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  if (offset !== buf.length && !opts.stopAfterFlush) throw new Error('truncated pkt-line header');
  return { packets, consumed: offset };
}

/** Wrap bytes in sideband pkt-lines (band 1 = data), chunked under the pkt-line max. */
export function sideband(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([band])));
    return out;
  }
  for (let i = 0; i < data.length; i += CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([band]), data.subarray(i, i + CHUNK)])));
  }
  return out;
}

function textLines(packets: Packet[]): string[] {
  const out: string[] = [];
  for (const p of packets) if (p.kind === 'data') out.push(p.payload.toString('utf8'));
  return out;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function allRefs(repo: Repo): Array<{ oid: string; name: string }> {
  const out: Array<{ oid: string; name: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ oid, name });
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

function headSha(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.default_branch}`) ?? null;
}

/** The peeled target of an annotated tag ref, or null. */
function peeledTarget(repo: Repo, oid: string): string | null {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'tag') return null;
  const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return m ? m[1]! : null;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(pktFlush);
  const head = headSha(repo);
  if (service === 'git-upload-pack') {
    const caps = `symref=HEAD:refs/heads/${repo.default_branch} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`;
    if (head === null) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    }
  } else {
    const caps = `symref=HEAD:refs/heads/${repo.default_branch} report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
    if (head === null) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    }
  }
  for (const ref of allRefs(repo)) {
    parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    const peeled = peeledTarget(repo, ref.oid);
    if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

function v2Advertisement(service: 'git-upload-pack'): Buffer {
  const parts: Buffer[] = [
    pktLine(`# service=${service}\n`),
    pktFlush,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    pktFlush,
  ];
  return Buffer.concat(parts);
}

export function infoRefsBody(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', version2: boolean): Buffer {
  if (service === 'git-upload-pack' && version2) return v2Advertisement(service);
  return v0Advertisement(repo, service);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, packets: Packet[]): Buffer {
  // Lines before delim are the command; after delim are arguments.
  let afterDelim = false;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const p of packets) {
    if (p.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = headSha(repo);
  if (head !== null) {
    if (keep('HEAD')) {
      parts.push(pktLine(`${head} HEAD${symrefs ? ` symref-target:refs/heads/${repo.default_branch}` : ''}\n`));
    }
  } else if (unborn) {
    if (keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.default_branch}` : ''}\n`));
    }
  }
  for (const ref of allRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledTarget(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  deepenSince: number | undefined;
  deepenNot: string[];
}

function parseV2FetchArgs(packets: Packet[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined, deepenSince: undefined, deepenNot: [] };
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    if (line.startsWith('want ')) req.wants.push(line.slice(5));
    else if (line.startsWith('have ')) req.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) req.deepenSince = parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) req.deepenNot.push(line.slice(11));
  }
  req.wants = [...new Set(req.wants)];
  return req;
}

function parseV0FetchArgs(packets: Packet[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined, deepenSince: undefined, deepenNot: [] };
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section++;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        // First want may carry capabilities after a space: "want <oid> <caps>".
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        req.wants.push(space < 0 ? rest : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8));
      else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7), 10);
      else if (line.startsWith('deepen-since ')) req.deepenSince = parseInt(line.slice(13), 10);
      else if (line.startsWith('deepen-not ')) req.deepenNot.push(line.slice(11));
    } else if (line.startsWith('have ')) {
      req.haves.push(line.slice(5));
    }
  }
  req.wants = [...new Set(req.wants)];
  return req;
}

/** Build the pack + shallow info for a fetch request. */
function buildFetchPack(repo: Repo, req: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const knownWants = req.wants.filter((oid) => getObject(repo, oid) !== undefined);
  const { objects, shallow, unshallow } = objectsForFetch(repo, knownWants, req.haves, req.depth, req.shallow);
  return { pack: writePack(objects), shallow, unshallow };
}

function fetchAcks(repo: Repo, req: FetchRequest): string[] {
  const acks: string[] = [];
  for (const have of req.haves) {
    if (!getCommit(repo, have)) continue;
    if (req.wants.some((want) => isAncestor(repo, have, want))) acks.push(have);
  }
  return acks;
}

function handleFetchV2(repo: Repo, packets: Packet[]): Buffer {
  const req = parseV2FetchArgs(packets);
  const acks = fetchAcks(repo, req);
  const { pack, shallow, unshallow } = buildFetchPack(repo, req);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (acks.length) {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktFlush);
  if (shallow.length || unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush);
  }
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const ref of allRefs(repo)) {
    if (req.wants.includes(ref.oid)) wantedRefs.push({ oid: ref.oid, ref: ref.name });
  }
  const head = headSha(repo);
  if (head && req.wants.includes(head)) wantedRefs.unshift({ oid: head, ref: 'HEAD' });
  if (wantedRefs.length) {
    parts.push(pktLine('wanted-refs\n'));
    for (const w of wantedRefs) parts.push(pktLine(`${w.oid} ${w.ref}\n`));
    parts.push(pktFlush);
  }
  parts.push(pktLine('packfile\n'));
  for (const chunk of sideband(1, pack)) parts.push(chunk);
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, packets: Packet[]): Buffer {
  const req = parseV0FetchArgs(packets);
  const acks = fetchAcks(repo, req);
  const { pack, shallow, unshallow } = buildFetchPack(repo, req);
  const parts: Buffer[] = [];
  if (acks.length) {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const chunk of sideband(1, pack)) parts.push(chunk);
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack entry point
// ---------------------------------------------------------------------------

export function handleUploadPack(repo: Repo, body: Buffer, version2: boolean): Buffer {
  const { packets } = decodePktLines(body);
  if (version2) {
    const first = textLines(packets)[0] ?? '';
    if (first.startsWith('command=ls-refs')) return handleLsRefs(repo, packets);
    if (first.startsWith('command=fetch')) return handleFetchV2(repo, packets);
    throw new Error(`unknown v2 command ${JSON.stringify(first)}`);
  }
  return handleFetchV0(repo, packets);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, consumed } = decodePktLines(body, { stopAfterFlush: true });
  const commands: PushCommand[] = [];
  let sidebandRequested = false;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8');
    const nul = line.indexOf('\0');
    let caps = '';
    if (nul >= 0) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
      if (caps.includes('side-band-64k')) sidebandRequested = true;
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad push command ${JSON.stringify(line)}`);
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) throw new Error('empty push command list');

  // The pack follows the flush packet, raw.
  const packBytes = body.subarray(consumed);
  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const entries = readPack(packBytes, (oid) => getObject(repo, oid));
      for (const entry of entries) {
        if (!repo.objects.has(entry.oid)) {
          repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  for (const cmd of commands) {
    if (!unpackOk) {
      report.push({ ref: cmd.ref, ok: false, reason: unpackDetail });
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        report.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
      } else {
        repo.refs.delete(cmd.ref);
        report.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Create or update: the new object must exist in the store. Branch refs point at
    // commits; tag refs may point at a tag object (or a commit).
    const newObj = getObject(repo, cmd.newOid);
    if (!newObj) {
      report.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.ref.startsWith('refs/heads/') && newObj.type !== 'commit') {
      report.push({ ref: cmd.ref, ok: false, reason: 'not a commit' });
      continue;
    }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) {
        report.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (cmd.oldOid !== current) {
      report.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
      continue;
    }
    // Fast-forward only for branch refs (tag refs just need the old value to match).
    if (cmd.ref.startsWith('refs/heads/') && !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    report.push({ ref: cmd.ref, ok: true, reason: '' });
  }

  const inner: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const r of report) {
    inner.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  const innerBytes = Buffer.concat(inner);
  const parts: Buffer[] = [];
  if (sidebandRequested) {
    for (const chunk of sideband(1, innerBytes)) parts.push(chunk);
  } else {
    parts.push(innerBytes);
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

export function getRepoForGit(owner: string, name: string): Repo | undefined {
  return getRepo(owner, name);
}
