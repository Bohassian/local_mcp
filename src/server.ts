import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import type { Endpoint } from './endpoint.js';
import { docsEndpoint } from './docs/endpoint.js';

// The HTTP server. Routes each request to an endpoint by URL path and keeps
// track of client sessions.

// The endpoints this server hosts. To add one, write a module like
// src/docs/endpoint.ts and list it here.
const endpoints: Endpoint[] = [await docsEndpoint()];

// Hostnames clients may use to reach us: from the host machine, or from
// another container by name.
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', 'local-mcp']);

// Open sessions, keyed by the id clients send in the `mcp-session-id` header.
type Session = { path: string; transport: StreamableHTTPServerTransport };
const sessions = new Map<string, Session>();

// Blocks DNS rebinding, which the MCP spec requires for HTTP servers. A web
// page that points its own hostname at this machine sends that hostname as
// Host, and browsers send Origin with cross-site requests. MCP clients don't.
function isAllowed(req: http.IncomingMessage): boolean {
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  return ALLOWED_HOSTNAMES.has(hostname) && req.headers.origin === undefined;
}

function reply(res: http.ServerResponse, status: number, body?: string) {
  res.writeHead(status).end(body);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  // 1. Find the endpoint for this path.
  const endpoint = endpoints.find((e) => e.path === req.url);
  if (!endpoint) return reply(res, 404);

  // 2. Refuse requests that could come from a web page.
  if (!isAllowed(req)) {
    console.log(`refused host=${req.headers.host} origin=${req.headers.origin}`);
    return reply(res, 403);
  }

  // 3. Requests in an existing session go to that session's transport.
  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId === 'string') {
    const session = sessions.get(sessionId);
    if (session?.path !== endpoint.path) return reply(res, 404, 'unknown session');
    return session.transport.handleRequest(req, res);
  }

  // 4. Otherwise a client is starting a session: give it its own transport and
  // server. The SDK picks the session id; we record it once the session starts.
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: (id) => {
      sessions.set(id, { path: endpoint.path, transport });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await endpoint.newServer().connect(transport);
  await transport.handleRequest(req, res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('request error:', err);
    if (!res.headersSent) reply(res, 500);
  });
});

server.listen(config.port, '0.0.0.0', () => {
  for (const e of endpoints) console.log(`listening on http://0.0.0.0:${config.port}${e.path}`);
});

// On Ctrl+C or `docker stop`: stop accepting requests, then close endpoints.
function shutdown() {
  server.close(() => {
    for (const e of endpoints) e.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
