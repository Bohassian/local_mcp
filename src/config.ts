import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Settings, from environment variables. On the host, ./.env fills in any that
// aren't set; in Docker, compose sets them.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // above src/ or dist/

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (key: string, fallback: string) => process.env[key] || fallback;

export const config = {
  // Port the MCP server listens on.
  port: Number(env('MCP_PORT', '3939')),
  // Ollama, for embeddings.
  embedUrl: env('EMBED_URL', 'http://localhost:11434'),
  // Downloaded docs and databases.
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),
};
