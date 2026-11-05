import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// One MCP server, mounted at `path`. The SDK binds a server to a single
// client session, so `newServer` is called once per session.
export interface Endpoint {
  path: string;
  newServer(): McpServer;
  close(): void;
}

export type ToolResult = { content: Array<{ type: 'text'; text: string }> };

export const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

// Wraps a tool handler to log one line per call, so `docker compose logs -f`
// shows what the model asked for and how much came back.
export function logged<A>(name: string, handler: (args: A) => ToolResult | Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    const started = Date.now();
    const call = `${name} ${JSON.stringify(args)}`;
    try {
      const result = await handler(args);
      const chars = result.content.reduce((n, c) => n + c.text.length, 0);
      console.log(`${call} -> ${chars} chars, ${Date.now() - started} ms`);
      return result;
    } catch (err) {
      console.log(`${call} -> error: ${(err as Error).message}`);
      throw err;
    }
  };
}
