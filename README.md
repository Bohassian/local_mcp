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
    ingest/            npm run ingest / fetch-docs, plus a reader per doc format
    eval/              npm run eval / explain / embed-drift, plus question sets
data/                Gitignored: downloaded docs and docs.db
docs/                HOW_IT_WORKS.md: concepts and a guided tour of the code
```

The server runs in Docker. The npm scripts (ingest, eval) run on the host and share `data/` with it through a bind mount.

## Run

Needs Docker, plus Node 24 on the host: 24.22.2, the version CI uses (`.github/workflows/ci.yml`). Its bundled npm must be 11.10+ for the `min-release-age` setting in `.npmrc`. Ollama runs on the CPU unless you enable a GPU with `COMPOSE_FILE` in `.env`: NVIDIA (needs the NVIDIA container toolkit) or AMD (ROCm). See `.env.example`. The CPU is fine for search queries, but ingesting large sources is much slower.

```bash
cp .env.example .env
# set MCP_TOKEN in .env:  openssl rand -hex 32
npm ci
docker compose up -d --build     # ollama, ollama-pull (fetches the model once), mcp
```

The server checks the embedding model at startup and exits if it's missing or the wrong size. It also exits if `MCP_TOKEN` is unset or shorter than 32 characters.

```bash
docker compose logs -f mcp       # one line per tool call: args, result size, time
npx @modelcontextprotocol/inspector@0.21.2 http://localhost:3939/docs   # try the tools by hand
```

In the Inspector, put the token under Authentication → Bearer Token.

### Connecting clients

MCP clients connect to `http://localhost:3939/<endpoint>`, e.g. `http://localhost:3939/docs`, and must send `Authorization: Bearer <MCP_TOKEN>`. Requests without it get a 401. Containers on the same Docker network can use `http://local-mcp:3939/<endpoint>`.

```bash
# Claude Code
claude mcp add --transport http docs http://localhost:3939/docs --header "Authorization: Bearer $MCP_TOKEN"
# pi
pi mcp add docs --url http://localhost:3939/docs --bearer-token-env-var MCP_TOKEN
```

### Serving the home network

The server can listen on the machine's LAN address as well as on localhost. In `.env`:

1. Add `docker-compose.lan.yml` to `COMPOSE_FILE`.
2. Set `MCP_LAN_IP` to the machine's LAN address. Give the machine a fixed address with a DHCP reservation.
3. Set `MCP_ALLOWED_HOSTS` to every name clients will put in the URL, e.g. `gpubox,gpubox.local,192.168.1.50`. Requests using any other name are refused with a 403. This is the DNS-rebinding check.

Then run `docker compose up -d`, and point clients at `http://gpubox:3939/docs` with the same token. Traffic is plain HTTP, so the token crosses the LAN unencrypted. That's fine on a home network. Use Tailscale or a TLS proxy if you need more. Ollama stays on localhost either way.

## Docs endpoint

### Sources

Defined in `src/docs/sources.json`. Each entry has a `format` (`rst`, `godot-classref`, `markdown` or `devdocs`), a `path` under `data/`, and optional `include` path prefixes.

| Source | From |
|---|---|
| `godot-manual`, `godot-api` | `data/godot-docs/` (git clone) |
| `rails~7.1`, `rails~8.1`, `ruby~3.2`, `ruby~4.0` | `data/devdocs/` (`npm run fetch-docs`) |
| `reference` | `data/reference/`: your own markdown notes (optional) |

### Get the docs and ingest them

```bash
git clone --depth 1 https://github.com/godotengine/godot-docs data/godot-docs
npm run fetch-docs -- rails~7.1 ruby~3.2 rails~8.1 ruby~4.0
docker compose up -d ollama
npm run ingest -- --all          # or: npm run ingest -- godot-api
```

Each run replaces that source's rows. It embeds everything before writing, so a failed run leaves the previous copy intact. The server picks up new sources for new sessions, with no restart needed.

To refresh, `git -C data/godot-docs pull`, re-run `npm run fetch-docs -- ...` (it only downloads changed bundles), then `npm run ingest -- --all`.

### Measure retrieval

```bash
npm run eval                     # godot set, k=5, every search mode
npm run eval -- rails 5 hybrid
```

To see why one query returns what it does (each search method's ranking, the fused scores, the final results):

```bash
npm run explain -- "move_and_slide floor detection" --sources godot-manual,godot-api
```

The eval reports hit@k and MRR per question kind. Run it before and after changing readers, chunking or search.

## Adding an endpoint

1. Create `src/<name>/endpoint.ts` exporting a function that returns an `Endpoint` (see `src/endpoint.ts`): a `path`, a `newServer()` that builds an `McpServer` and registers its tools, and a `close()`.
2. Add it to the `endpoints` list in `src/server.ts`.
3. Point your MCP client at `http://localhost:3939/<path>`.

`src/docs/endpoint.ts` is the worked example.

## Tests

```bash
npm test                         # no Ollama or docs.db needed
```

The tests (`src/**/*.test.ts`) double as examples of how chunking, the readers and each search stage behave.

## Updating dependencies

Versions only move deliberately: npm packages through `package-lock.json` (installed with `npm ci`), Docker images through exact tags (the Node base image also by digest).

- **Releases must be at least 14 days old.** Most compromised packages are caught and pulled within days. `.npmrc` sets `min-release-age=14`, so `npm install` and `npm audit fix` won't pick anything newer. Docker images have no such gate: pick the newest tag past the cutoff by hand and note its release date in the pin comment (see `docker-compose.yml`).
- **Install scripts are off** (`.npmrc`: `ignore-scripts=true`), on the host and in Docker. Nothing here needs them: better-sqlite3 and sqlite-vec ship prebuilt binaries in their npm packages. Before adding a native package, run `npm view <pkg> scripts`. One that needs an install or postinstall step installs cleanly but fails when loaded. The image has no compilers, so building from source would mean adding them back.
- **Stay on Debian images, not Alpine.** sqlite-vec has no musl build. The base image is Debian 13 (trixie).
- **The Node version is in three places**: the Dockerfile's two `FROM` lines (version and digest), `node-version` in `ci.yml`, and your host's Node. Dependabot only updates the Dockerfile, so change the other two with it. A new Node major is a deliberate change, not a Dependabot PR.
- **Pass script arguments after `--`**, e.g. `npm run ingest -- --all`. Without it, npm takes `--all` as its own option.
- **Dependabot** (`.github/dependabot.yml`) opens weekly PRs for npm packages, the Node base image, the Ollama image and the CI actions, with the same 14-day cooldown. npm minor and patch bumps come grouped as one PR. Majors come one PR each, except TypeScript and `@types/node`, which are bumped by hand.
- **Security-update PRs skip the cooldown**: Dependabot opens them as soon as a fix is out. Leave one unmerged until the fix is 14 days old, unless the vulnerability affects how this server runs.
- **Once a month, refresh indirect dependencies by hand.** Dependabot only bumps packages listed in `package.json`. Indirect ones, such as those under the MCP SDK, otherwise move only when a security advisory forces it. On a branch:

  ```bash
  npm update                       # within package.json ranges; respects min-release-age and ignore-scripts
  git diff package-lock.json       # review what moved
  npm audit && npm run typecheck && npm test
  ```

  Then open a PR so CI runs. `npm update` can also move a package *back* to an older version if the locked one is younger than 14 days. That's the age gate working, not a mistake.
- **CI** (`.github/workflows/ci.yml`) runs on every PR: `npm ci`, `npm audit signatures` (each package is the one the registry signed), `npm audit --audit-level=high`, typecheck, tests, the Docker build, and a check that the native modules load inside the image. It can't run the server or the evals.
- **Before merging a bump**, run `npm run eval` for all three sets (`godot`, `rails`, `holdout`) and compare against the numbers from before. For a change made by hand, also run what CI runs: `npm audit`, `npm run typecheck`, `npm test`, `docker compose build mcp`.
- **Bumping Ollama** can change the vectors the embedding model returns, so they no longer match the ones in `docs.db`. Run `npm run embed-drift` before and after. Identical vectors give 1.00000. A median around 0.999 with an unchanged eval needs nothing. Anything clearly lower means `npm run ingest -- --all`. Changing `EMBED_MODEL` always needs a re-ingest (see `src/docs/store.ts`).
