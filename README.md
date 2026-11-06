# local_mcp

Local MCP server. One HTTP server hosts several MCP **endpoints**, one per URL path. Today there is one:

| Endpoint | Tools |
|---|---|
| `/docs` | `list_docs`, `search_docs` (keyword + semantic + symbol search), `lookup_symbol`, `read_doc` |

Nothing leaves the machine at runtime. Embeddings come from a local Ollama.

New to search, embeddings or MCP? [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) explains the concepts and walks a real query through the code.

## Layout

```
src/
  server.ts          HTTP server: routes each path to its endpoint, holds sessions
  endpoint.ts        The Endpoint interface + tool logging helper
  config.ts          Settings from the environment (and .env on the host)
  embed.ts           Ollama embeddings client
  docs/              The /docs endpoint
    endpoint.ts        Its MCP tools
    search.ts          Hybrid search (vector + FTS + symbols)
    store.ts           SQLite schema for data/docs.db
    sources.json       Which docs to ingest
    ingest/            yarn ingest / fetch-docs, plus a reader per doc format
    eval/              yarn eval, plus question sets
data/                Gitignored: downloaded docs and docs.db
docs/                HOW_IT_WORKS.md: concepts and a guided tour of the code
```

The server runs in Docker. The `yarn` scripts (ingest, eval) run on the host and share `data/` with it through a bind mount.

## Run

Needs Docker, plus Node 24 and Yarn 1 on the host. Ollama runs on the CPU unless you enable a GPU with `COMPOSE_FILE` in `.env`: NVIDIA (needs the NVIDIA container toolkit) or AMD (ROCm). See `.env.example`. The CPU is fine for search queries, but ingesting large sources is much slower.

```bash
cp .env.example .env
yarn install
docker compose up -d --build     # ollama, ollama-pull (fetches the model once), mcp
```

The server checks the embedding model at startup and exits if it's missing or the wrong size.

```bash
docker compose logs -f mcp       # one line per tool call: args, result size, time
npx @modelcontextprotocol/inspector@0.21.2 http://localhost:3939/docs   # try the tools by hand
```

MCP clients connect to `http://localhost:3939/<endpoint>`, e.g. `http://localhost:3939/docs`. Containers on the same Docker network can use `http://local-mcp:3939/<endpoint>`.

## Docs endpoint

### Sources

Defined in `src/docs/sources.json`. Each entry has a `format` (`rst`, `godot-classref`, `markdown` or `devdocs`), a `path` under `data/`, and optional `include` path prefixes.

| Source | From |
|---|---|
| `godot-manual`, `godot-api` | `data/godot-docs/` (git clone) |
| `rails~7.1`, `rails~8.1`, `ruby~3.2`, `ruby~4.0` | `data/devdocs/` (`yarn fetch-docs`) |
| `reference` | `data/reference/`: your own markdown notes (optional) |

### Get the docs and ingest them

```bash
git clone --depth 1 https://github.com/godotengine/godot-docs data/godot-docs
yarn fetch-docs rails~7.1 ruby~3.2 rails~8.1 ruby~4.0
docker compose up -d ollama
yarn ingest --all                # or: yarn ingest godot-api
```

Each run replaces that source's rows. It embeds everything before writing, so a failed run leaves the previous copy intact. The server picks up new sources for new sessions, with no restart needed.

To refresh, `git -C data/godot-docs pull`, re-run `yarn fetch-docs ...` (it only downloads changed bundles), then `yarn ingest --all`.

### Measure retrieval

```bash
yarn eval                        # godot set, k=5, every search mode
yarn eval rails 5 hybrid
```

To see why one query returns what it does (each search method's ranking, the fused scores, the final results):

```bash
yarn explain "move_and_slide floor detection" --sources godot-manual,godot-api
```

The eval reports hit@k and MRR per question kind. Run it before and after changing readers, chunking or search.

## Adding an endpoint

1. Create `src/<name>/endpoint.ts` exporting a function that returns an `Endpoint` (see `src/endpoint.ts`): a `path`, a `newServer()` that builds an `McpServer` and registers its tools, and a `close()`.
2. Add it to the `endpoints` list in `src/server.ts`.
3. Point your MCP client at `http://localhost:3939/<path>`.

`src/docs/endpoint.ts` is the worked example.

## Tests

```bash
yarn test                        # no Ollama or docs.db needed
```

The tests (`src/**/*.test.ts`) double as examples of how chunking, the readers and each search stage behave.
