import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import type { Endpoint } from './endpoint.js';
import { docsEndpoint } from './docs/endpoint.js';

// Every MCP endpoint this server hosts. To add one, write a module like
// src/docs/endpoint.ts and list it here.
const endpoints: Endpoint[] = [await docsEndpoint()];

// DNS rebinding guard (the MCP spec requires one for HTTP servers). A web page
// that rebinds its hostname to this machine sends that hostname as Host, and
// browsers send Origin on cross-site POSTs. MCP clients and curl send none.
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', 'local-mcp']);

function isAllowed(req: http.IncomingMessage): boolean {
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  return ALLOWED_HOSTNAMES.has(hostname) && req.headers.origin === undefined;
}

// Open client sessions, by the id the client sends in `mcp-session-id`.
const sessions = new Map<string, { path: string; transport: StreamableHTTPServerTransport }>();

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const endpoint = endpoints.find((e) => e.path === req.url);
  if (!endpoint) return void res.writeHead(404).end();
  if (!isAllowed(req)) {
    console.log(`refused host=${req.headers.host} origin=${req.headers.origin}`);
    return void res.writeHead(403).end();
  }

  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId === 'string') {
    const session = sessions.get(sessionId);
    if (session?.path !== endpoint.path) return void res.writeHead(404).end('unknown session');
    return session.transport.handleRequest(req, res);
  }

  // No session id: a client starting a new session.
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
    if (!res.headersSent) res.writeHead(500).end();
  });
});

server.listen(config.port, '0.0.0.0', () => {
  for (const e of endpoints) console.log(`listening on http://0.0.0.0:${config.port}${e.path}`);
});

const shutdown = () => {
  server.close(() => {
    for (const e of endpoints) e.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
