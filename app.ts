// app.ts — the forge's HTTP server: routing, auth, body parsing, replies.
//
//   GET  /healthz                                  -> {"ok": true}
//   GET  /{owner}/{repo}.git/info/refs             -> git advertisement (v2/v0)
//   POST /{owner}/{repo}.git/git-upload-pack       -> v2 ls-refs / fetch, or v0 fetch
//   POST /{owner}/{repo}.git/git-receive-pack      -> v0 push
//   /api/v3/*                                      -> REST v3 (bearer required)
//   POST /api/graphql                             -> GraphQL (bearer required)
//   POST /mcp                                     -> MCP (bearer required on tools/call only)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getRepo } from './store.ts';
import { handleReceivePack, handleUploadPack, infoRefsBody } from './git.ts';
import { handleRest, nextRequestId } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Bearer auth: must equal MAKEFUN_SHOP_TOKEN when set; any non-empty bearer otherwise. */
export function tokenValid(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected) return token === expected;
  return true;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      try {
        await route(req, res);
      } catch (err) {
        process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
  return server;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const origin = `http://${req.headers.host ?? 'localhost'}`;

  // Health probe (no auth).
  if (pathname === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch) {
    const owner = gitMatch[1]!;
    const repoName = gitMatch[2]!;
    const action = gitMatch[3]!;
    const repo = getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (action === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'unknown service' });
        return;
      }
      const version2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
      const body = infoRefsBody(repo, service, version2);
      sendBytes(res, 200, body, `application/x-${service}-advertisement`);
      return;
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      try {
        const version2 = req.headers['git-protocol'] === 'version=2';
        const out = handleUploadPack(repo, body, version2);
        sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
      } catch (err) {
        sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
      }
      return;
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      try {
        const out = handleReceivePack(repo, body);
        sendBytes(res, 200, out, 'application/x-git-receive-pack-result');
      } catch (err) {
        sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
      }
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const parts = pathname === '/api/v3' ? [] : pathname.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
    let body: unknown = undefined;
    let bodyError = false;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          bodyError = true;
        }
      }
    }
    const requestId = nextRequestId();
    if (bodyError) {
      sendJson(res, 400, { message: 'Invalid JSON in request body' }, { 'X-GitHub-Request-Id': requestId });
      return;
    }
    const authed = tokenValid(req);
    const result = handleRest({ method, parts, query: url.searchParams, body, origin, authed });
    const headers: Record<string, string> = { 'X-GitHub-Request-Id': requestId, ...(result.headers ?? {}) };
    if (result.status === 204) {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, headers);
    return;
  }

  // GraphQL.
  if (pathname === '/api/graphql' && method === 'POST') {
    if (!tokenValid(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
      return;
    }
    const out = executeGraphQL(body);
    sendJson(res, 200, out);
    return;
  }

  // MCP.
  if (pathname === '/mcp' && method === 'POST') {
    const raw = await readBody(req);
    const outcome = handleMcp(raw.toString('utf8'), tokenValid(req));
    if (outcome.isNotification) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
