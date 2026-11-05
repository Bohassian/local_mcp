import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// What every endpoint provides, plus helpers for writing tools.

// An MCP server mounted at a URL path, e.g. /docs.
export interface Endpoint {
  path: string;
  // The SDK ties a server to one client session, so this runs once per session.
  newServer(): McpServer;
  // Called on shutdown, to release resources such as a database.
  close(): void;
}

export type ToolResult = { content: Array<{ type: 'text'; text: string }> };

// A tool result that is just text.
export const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

// Wraps a tool handler to log each call: arguments, result size and time.
// `docker compose logs -f mcp` then shows what the model looked up.
export function logged<A>(name: string, handler: (args: A) => ToolResult | Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    const call = `${name} ${JSON.stringify(args)}`;
    const started = Date.now();
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
