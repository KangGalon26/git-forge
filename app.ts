// The forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL v4 and MCP from
// the one store. Routing and the wire contract live here; the surfaces live in rest.ts,
// graphql.ts, mcp.ts and git.ts. Every API surface takes the trial's bearer token
// (MAKEFUN_SHOP_TOKEN); /healthz is the env's unauthenticated boot probe.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER } from './store.ts';
import { RestSurface, type RestResponse } from './rest.ts';
import { GraphQLSurface } from './graphql.ts';
import { McpSurface } from './mcp.ts';
import {
  lsRefs,
  parseV0Request,
  parseV2Request,
  receivePack,
  v0Advertisement,
  v0FetchResponse,
  v2Advertisement,
  v2FetchResponse,
  type FetchRequest,
} from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export function createApp(): Server {
  const store = new Store();
  const rest = new RestSurface(store);
  const graphql = new GraphQLSurface(store);
  const mcp = new McpSurface(store);
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestSeq = 0;

  const authorized = (req: IncomingMessage): boolean => {
    if (token === '') return true;
    return req.headers.authorization === `Bearer ${token}`;
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    if (status === 204 || body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
  };

  const sendRest = (res: ServerResponse, answer: RestResponse): void => {
    requestSeq += 1;
    const headers: Record<string, string> = { 'x-github-request-id': `forge-${requestSeq}`, ...(answer.headers ?? {}) };
    if (answer.status === 204) {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.json, headers);
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const handleGit = async (req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, tail: string, query: URLSearchParams): Promise<void> => {
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined || repo.owner !== VIEWER.login) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Repository not found\n');
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized\n');
      return;
    }
    if (req.method === 'GET' && tail === 'info/refs') {
      const service = query.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Missing service\n');
        return;
      }
      const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
      const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
      res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (req.method === 'POST' && tail === 'git-upload-pack') {
      const body = await readBody(req);
      const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      let answer: Buffer | null = null;
      if (isV2) {
        const parsed = parseV2Request(body);
        if (parsed !== null && parsed.command === 'ls-refs') {
          const prefixes: string[] = [];
          let peel = false;
          let symrefs = false;
          let unborn = false;
          for (const arg of parsed.args) {
            if (arg === 'peel') peel = true;
            else if (arg === 'symrefs') symrefs = true;
            else if (arg === 'unborn') unborn = true;
            else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
          }
          answer = lsRefs(repo, { peel, symrefs, unborn, prefixes });
        } else if (parsed !== null && parsed.command === 'fetch') {
          const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
          for (const arg of parsed.args) {
            if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
            else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
            else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
            else if (arg.startsWith('deepen ')) request.depth = Number(arg.slice(7).trim());
            else if (arg === 'done') request.done = true;
          }
          answer = v2FetchResponse(store, repo, request);
        }
      } else {
        const parsed = parseV0Request(body);
        if (parsed !== null && parsed.wants.length > 0) answer = v0FetchResponse(store, repo, parsed);
      }
      if (answer === null) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('ERR unsupported or malformed upload-pack request\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache', 'content-length': answer.length });
      res.end(answer);
      return;
    }
    if (req.method === 'POST' && tail === 'git-receive-pack') {
      const body = await readBody(req);
      const result = receivePack(store, repo, body);
      res.writeHead(result.status, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache', 'content-length': result.body.length });
      res.end(result.body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found\n');
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://forge');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/api/graphql') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Unauthorized' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { errors: [{ message: 'GraphQL only accepts POST' }] });
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
          sendJson(res, 200, graphql.execute(body));
          return;
        }

        if (path === '/mcp') {
          if (!authorized(req)) {
            res.writeHead(401, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
            return;
          }
          if (method !== 'POST') {
            res.writeHead(405, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } }));
            return;
          }
          const raw = await readBody(req);
          const answer = mcp.handle(raw.toString('utf8'));
          if (answer.body === null) {
            res.writeHead(answer.status);
            res.end();
            return;
          }
          res.writeHead(answer.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(answer.body) });
          res.end(answer.body);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            sendRest(res, { status: 401, json: { message: 'Unauthorized' } });
            return;
          }
          const sub = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          let body: Record<string, unknown> | undefined;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                const parsed = JSON.parse(raw.toString('utf8')) as unknown;
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
                body = parsed as Record<string, unknown>;
              } catch {
                sendRest(res, { status: 400, json: { message: 'Malformed JSON in request body' } });
                return;
              }
            }
          }
          const origin = `http://${req.headers.host ?? 'forge'}`;
          sendRest(res, rest.handle({ method, path: sub, query: url.searchParams, body, origin }));
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          await handleGit(req, res, decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]), gitMatch[3], url.searchParams);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({ message: `Internal error: ${err instanceof Error ? err.message : String(err)}` }));
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}
