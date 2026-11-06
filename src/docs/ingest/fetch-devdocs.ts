import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

// Downloads DevDocs bundles into data/devdocs/<slug>/ for `format: devdocs`
// sources. The only networked docs step; ingest reads the local files.
//
//   npm run fetch-docs -- rails~7.1 ruby~3.2
//
// Re-downloads a bundle only when its mtime in the DevDocs catalog changed.

interface CatalogEntry {
  name: string;
  slug: string;
  release?: string;
  mtime: number;
}

const slugs = process.argv.slice(2);
if (slugs.length === 0) {
  console.error('Usage: npm run fetch-docs -- <slug>...   (e.g. rails~7.1 ruby~3.2)');
  process.exit(1);
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

const catalog = JSON.parse((await download('https://devdocs.io/docs.json')).toString()) as CatalogEntry[];

for (const slug of slugs) {
  const entry = catalog.find((e) => e.slug === slug);
  if (!entry) {
    console.error(`[${slug}] not in the DevDocs catalog; skipping`);
    continue;
  }
  const dir = path.join(config.dataDir, 'devdocs', slug);
  const metaPath = path.join(dir, 'meta.json');
  const existing = fs.existsSync(metaPath) ? (JSON.parse(fs.readFileSync(metaPath, 'utf8')) as CatalogEntry) : null;
  if (existing?.mtime === entry.mtime) {
    console.log(`[${slug}] up to date (${entry.name} ${entry.release ?? ''})`);
    continue;
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['index.json', 'db.json']) {
    process.stdout.write(`[${slug}] ${file} ... `);
    const body = await download(`https://documents.devdocs.io/${slug}/${file}?${entry.mtime}`);
    JSON.parse(body.toString('utf8')); // fail before writing a truncated file
    fs.writeFileSync(path.join(dir, file), body);
    console.log(`${(body.length / 1e6).toFixed(1)} MB`);
  }
  // Written last, so an interrupted fetch is retried next time.
  fs.writeFileSync(metaPath, JSON.stringify(entry, null, 2) + '\n');
  console.log(`[${slug}] done: ${entry.name} ${entry.release ?? ''}`);
}
