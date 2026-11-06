# local_mcp

A dockerized MCP server (TypeScript, Node 24) with hybrid doc search over a local
SQLite + sqlite-vec store, embedded by a local Ollama. Setup, layout and procedures
are in README.md; concepts and a guided code tour are in docs/HOW_IT_WORKS.md. Read
the relevant section before changing an area.

## Invariants
- Nothing leaves the machine at runtime. Don't add network calls beyond local Ollama.
- Keep the bearer-token auth and the MCP_ALLOWED_HOSTS (DNS-rebinding) check.
- `data/` is gitignored (downloaded docs, docs.db). Never commit it.

## Dependencies (supply chain)
- Only releases ≥14 days old; exact pins; lockfile via `npm ci`. Note the release
  date in pin comments for Docker images (no automatic gate there).
- Install scripts are off (.npmrc). Check `npm view <pkg> scripts` before adding a
  native package.
- Debian images only (sqlite-vec has no musl build).
- The Node version lives in 3 places: Dockerfile (both FROMs + digest), ci.yml, host.

## Verifying changes
- `npm run typecheck && npm test` (no Ollama/docs.db needed). For dependency changes
  also `npm audit` and `docker compose build mcp`.
- Changes to search, readers or chunking: `npm run eval` before and after
  (sets: godot, rails, holdout) and report the numbers. Baselines live in
  src/docs/eval/baselines/.
- Script args go after `--`: `npm run ingest -- --all`.

## Working with the user
- If Docker, Ollama or a secret (MCP_TOKEN) is needed and unavailable, ask the user
  to set it up and start the stack. Don't stub or fake services.

## Priorities for every change
- Security: say how the change affects the invariants above.
- Understandability: explain the *why* in plain language in comments, commit
  messages and PR text, for a reader with little context. Match the README's style:
  short, direct sentences.
- Education: back claims with primary sources (official docs, specs, release notes)
  and link them, so the explanation can be checked and learned from.