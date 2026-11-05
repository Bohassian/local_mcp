import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root: one level up from src/ (tsx) or dist/ (compiled).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Host-side scripts read ./.env. In Docker, compose sets the environment.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (key: string, fallback: string) => process.env[key] || fallback;

export const config = {
  port: Number(env('MCP_PORT', '3939')),
  embedUrl: env('EMBED_URL', 'http://localhost:11434'),
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),
};
