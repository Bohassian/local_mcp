# How local_mcp works

This guide is for engineers who are comfortable with code but new to search,
embeddings and MCP. It explains the ideas the code depends on, then follows a
real question through the system with real output from `data/docs.db`.
`yarn explain "<question>"` prints the same breakdown for any question you like.

The [README](../README.md) covers how to run things. This covers why the code
looks the way it does.

**Contents**

1. [The big picture](#the-big-picture)
2. [Concepts](#concepts): MCP, chunks and tokens, embeddings, nearest-neighbor
   search, keyword search, symbols, hybrid search and rank fusion
3. [The ingest path](#the-ingest-path): docs on disk to rows in SQLite
4. [The search path](#the-search-path): one query, step by step
5. [When search gets it wrong](#when-search-gets-it-wrong), and how to measure it
6. [The other tools](#the-other-tools)
7. [The server](#the-server): sessions and security
8. [Things to try](#things-to-try)
9. [Further reading](#further-reading)

---

## The big picture

An AI coding assistant (Claude Code, a local model, etc.) is writing code
against an API it may half-remember: Godot, Rails, Ruby. Instead of guessing, it
calls a tool on this server, `search_docs("move_and_slide floor detection")`,
and gets back the relevant passages from the real documentation. The answer
comes from documents on your machine, not the model's memory.

There are two halves, run at different times:

```
INGEST (yarn ingest, on the host, occasionally)

  docs on disk ──► reader ──► sections ──► chunker ──► chunks ──► embedding model ──► vectors
  (.rst, .md,       per                                  │            (Ollama)            │
   DevDocs JSON)    format                               └──────────────┬─────────────────┘
                                                                        ▼
                                                                  data/docs.db
                                                                        ▲
SEARCH (the MCP server, in Docker, on every tool call)                  │
                                                                        │
  assistant ──► MCP tool call ──► query ──┬─► vector search ──┐         │
                                          ├─► keyword search ─┼─► fuse ─┴─► top 5 chunks ──► assistant
                                          └─► symbol search ──┘
```

Ingest does the expensive work once: reading, splitting, and running every
chunk through the embedding model. At query time, the only model call is
embedding the question itself (about 70 ms); everything else is SQLite.

Today's database holds 6 sources, 4,334 pages, 63,899 chunks and 50,851 API
symbols.

---

## Concepts

Each concept has a plain explanation, then where this codebase uses it, then
where to read more.

### MCP

**What it is.** The Model Context Protocol is a standard way for an AI
application to discover and call tools hosted by another program. The AI app is
the *client*; this project is a *server*. A server advertises tools (a name, a
description, and a JSON schema for the arguments); the model reads the
descriptions and decides when to call them. Messages are JSON-RPC, here sent
over HTTP ("Streamable HTTP" transport).

**Here.** [src/server.ts](../src/server.ts) is the HTTP layer: one URL path per
*endpoint* (today only `/docs`), with a session per connected client.
[src/docs/endpoint.ts](../src/docs/endpoint.ts) registers the four tools. The
tool descriptions are deliberately bossy ("CALL THIS BEFORE writing code…")
because models, especially small local ones, otherwise don't call retrieval
tools often enough. The description is a prompt.

**Read more.** [MCP architecture overview](https://modelcontextprotocol.io/docs/learn/architecture)
(start here) · [Spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25),
the version the installed SDK speaks · [Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
· [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

### Chunks and tokens

**What it is.** We don't search whole pages; we search *chunks*: passages of
a few hundred words. There are three reasons:

1. An embedding (below) summarizes a text as one point. A whole page about ten
   things becomes a blurry average of all ten; a passage about one thing stays
   sharp.
2. The embedding model has a maximum input length, measured in *tokens*
   (word pieces; about 4 characters of English each).
3. The results go into the assistant's limited context window. Five focused
   passages beat five whole pages.

**Overlap**: the last paragraph of each chunk is repeated at the start of the
next, so a thought that straddles a boundary can be found from either side.

**Here.** Readers in [src/docs/ingest/readers/](../src/docs/ingest/readers/)
first split pages at their headings into *sections*;
[chunk.ts](../src/docs/ingest/chunk.ts#L15) then splits long sections into
chunks of about 500 tokens (2,000 characters), hard-capped at twice that.
Average chunk today: 475 characters. The tests in
[chunk.test.ts](../src/docs/ingest/chunk.test.ts) show each rule with small
examples.

**Read more.** [Pinecone: Chunking Strategies](https://www.pinecone.io/learn/chunking-strategies/)

### Embeddings

**What it is.** An embedding model turns a piece of text into a list of
numbers, a *vector*, such that texts with similar meanings get similar
vectors. "How do I make my character leap?" and a passage titled "Jumping" share
no words, but their vectors land close together. Each number is a learned
dimension of meaning. None of them is individually readable.

The model here, `qwen3-embedding:4b`, produces 2,560 numbers per text. The
first five for "move_and_slide floor detection" are
`-0.0000, -0.0086, 0.0007, -0.0343, -0.0004`.

**Asymmetric prefixes.** Questions and answers are worded differently ("how do
I…" vs. "Moves the body based on velocity…"). Qwen3-Embedding was trained with
an instruction prepended to *queries only*, telling it what kind of match to
look for. So queries get `QUERY_PREFIX` and documents get nothing.

**Here.** [embed.ts](../src/embed.ts#L8) calls Ollama's `/api/embed`.
[store.ts](../src/docs/store.ts#L15-L23) pins the model, the vector size and
the prefixes. These are tied to the stored data: change any of them and the
stored vectors no longer match the query vectors, so you must re-ingest. The
server checks the vector size at startup
([endpoint.ts:17](../src/docs/endpoint.ts#L17)).

**Read more.** [The Illustrated Word2vec](https://jalammar.github.io/illustrated-word2vec/)
(intuition) · [SBERT: Semantic Search](https://www.sbert.net/examples/applications/semantic-search/README.html)
(symmetric vs. asymmetric search) · [Qwen3-Embedding-4B model card](https://huggingface.co/Qwen/Qwen3-Embedding-4B)
· [Qwen3 Embedding paper](https://arxiv.org/abs/2506.05176) · [Ollama embed API](https://docs.ollama.com/api/embed)

### Nearest-neighbor (vector) search

**What it is.** Embed the question, then find the stored vectors closest to it:
the *k nearest neighbors* (KNN). "Close" is a distance between points in
2,560-dimensional space; smaller is more similar.

**Here.** [sqlite-vec](https://github.com/asg017/sqlite-vec) adds a `vec0`
virtual table to SQLite ([store.ts:61](../src/docs/store.ts#L61)) that does
the KNN, queried with `WHERE embedding MATCH ? AND k = 50`
([search.ts:45](../src/docs/search.ts#L45)). It checks every vector rather
than using an approximate index. At ~64k chunks that's still fast, and the
results are exact. Vectors are stored as 32-bit floats, hence
[`toBuffer`](../src/docs/store.ts#L103).

**Read more.** [sqlite-vec: vec0 tables](https://alexgarcia.xyz/sqlite-vec/features/vec0.html)
· [sqlite-vec: KNN queries](https://alexgarcia.xyz/sqlite-vec/features/knn.html)

### Keyword search: FTS5 and BM25

**What it is.** Classic search-engine matching on the actual words. It's
strong exactly where embeddings are weak: rare exact terms like
`get_floor_normal` or `PLATFORM_ON_LEAVE_ADD_UPWARD_VELOCITY`, which an
embedding model may blur into "something about floors". **BM25** is the
standard formula for ranking keyword matches. A document scores higher when it
contains the query's words often, when those words are rare across the whole
collection, and when it's short (so a match means more).

**Here.** SQLite's built-in FTS5 index ([store.ts:69](../src/docs/store.ts#L69))
over each chunk's heading and text. [`ftsIds`](../src/docs/search.ts#L65)
ORs the query words together and weights heading matches 10× body matches.

**Read more.** [SQLite FTS5](https://www.sqlite.org/fts5.html) (see "The bm25()
function") · [Robertson & Zaragoza, *The Probabilistic Relevance Framework: BM25 and Beyond*](https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf)
(the math, for the curious)

### Symbols

**What it is.** This one is specific to this project, not a standard term.
A *symbol* is an API name the docs define: a class (`CharacterBody2D`), or a
member (`CharacterBody2D.move_and_slide`, `ActiveRecord::QueryMethods#where`).
Readers extract them from the docs' own structure, e.g. Godot's
`.. _class_Label_property_text:` labels. Each points at the chunk that
documents it.

**Here.** The `symbols` table ([store.ts:76](../src/docs/store.ts#L76)) stores
the full name, the member part alone (`move_and_slide`), and a kind. They power
two things: the `lookup_symbol` tool, and the third search list,
[`symbolIds`](../src/docs/search.ts#L134). That list looks for API names in
the query in four stages, in priority order, each its own function:

| Stage | Query | Matches | Function |
|---|---|---|---|
| 1. Qualified name | `Tween.tween_property` | that exact symbol | [`exactQualifiedNames`](../src/docs/search.ts#L151) |
| 2. Class + member in plain words | `label text` | `Label.text` | [`membersOfNamedClasses`](../src/docs/search.ts#L168) |
| 3. The class itself | `camera` | `Camera2D`, `Camera3D` | [`classesNamedBy`](../src/docs/search.ts#L157) |
| 4. Bare name | `move_and_slide` | every class's `move_and_slide` | [`bareNames`](../src/docs/search.ts#L186) |

The three SQL lookups they share (by full name, by member name, by class)
are in [`symbolLookups`](../src/docs/search.ts#L99).

Plain words only count as API names in limited cases. Otherwise "play" or
"where" would match hundreds of members
([`looksLikeIdentifier`](../src/docs/search.ts#L86)).

### Hybrid search and reciprocal rank fusion

**What it is.** Each search method is good at different questions:

| Method | Good at | Bad at |
|---|---|---|
| Vector | "How do I…" questions, synonyms, paraphrase | Exact rare names |
| Keyword | Exact words and names | Synonyms ("leap" ≠ "jump") |
| Symbol | API names written the way the docs write them | Anything else |

So we run all three and merge. The problem is that their scores aren't
comparable: a vector distance of 0.92, a BM25 score (FTS5 reports these as
negative numbers) and a symbol match (no score at all) aren't on any common
scale. **Reciprocal rank fusion
(RRF)** sidesteps this by ignoring scores and using only *positions*. An item
at rank *r* in a list earns `1 / (60 + r)` from that list, and its total is the
sum across lists:

| Rank | Contribution |
|---|---|
| 1 | 1/61 = 0.0164 |
| 2 | 1/62 = 0.0161 |
| 10 | 1/70 = 0.0143 |
| 50 | 1/110 = 0.0091 |

The constant 60 flattens the curve, so being 1st instead of 10th matters only
a little. Showing up in *several* lists matters a lot. RRF bets that when
independent methods agree, they're probably right.

**Here.** [`fuse`](../src/docs/search.ts#L197) is the whole algorithm in five
lines. [`searchDocs`](../src/docs/search.ts#L205) is three steps:
[`candidateLists`](../src/docs/search.ts#L226) runs the methods, `fuse` merges them, and
[`topResults`](../src/docs/search.ts#L248) keeps the best, at most 2 per page
(`MAX_PER_PAGE`), so one giant class page can't fill every slot.

**Read more.** [Cormack, Clarke & Büttcher, *Reciprocal Rank Fusion* (SIGIR 2009)](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
(two pages and readable; the source of the 60)

---

## The ingest path

`yarn ingest godot-api` runs [ingest.ts](../src/docs/ingest/ingest.ts) on the
host. For one source:

1. **Find the source's config** in [sources.json](../src/docs/sources.json):
   its `format`, its folder under `data/`, and which subfolders to include.

2. **Read pages** ([`readPages`](../src/docs/ingest/ingest.ts#L51)). The
   format picks a *reader* ([`READERS`](../src/docs/ingest/ingest.ts#L33)).
   Each reader turns one file into a `Page`
   ([types.ts](../src/docs/ingest/readers/types.ts)): a title, the raw body,
   `sections` split at headings, and any `symbols`. For example, the Godot
   class reader turns `classes/class_characterbody2d.rst` into one section per
   method and property, each with a matching symbol. See
   [readers.test.ts](../src/docs/ingest/readers/readers.test.ts) for a small
   real example.

3. **Chunk** every section with `chunkText`. Section headings are prefixed with
   the page title ("Using CharacterBody2D/3D › Platformer movement") so each
   chunk carries its context.

4. **Embed everything first** ([ingest.ts:84](../src/docs/ingest/ingest.ts#L84)),
   in batches of 32, *before touching the database*. This takes minutes on a
   GPU and much longer on CPU. Doing it first means a crash halfway leaves the
   old copy of the source intact. Two details:
   - The text sent to the model is cleaned by
     [`embeddingText`](../src/docs/ingest/embed-chunks.ts#L6). Table borders
     like `+-----+` cost tokens and mean nothing. The stored text keeps them.
   - If a batch is too long for the model,
     [`embedChunks`](../src/docs/ingest/embed-chunks.ts#L18) retries one at a
     time, halving any chunk that still doesn't fit.

5. **Write in one transaction** ([ingest.ts:112](../src/docs/ingest/ingest.ts#L112)).
   It deletes the source's old rows, then inserts pages, chunks, vectors (into
   `chunks_vec`), keyword index entries (`chunks_fts`) and symbols. Each symbol
   is linked to the first chunk of its section via its anchor. The transaction
   means the server never sees a half-written source.

What ends up in the database:

```
sources       one row per source, with counts and version
pages         full page text (read_doc returns this)
chunks        the searchable passages, each pointing at its page
chunks_vec    one 2560-number vector per chunk          ← vector search
chunks_fts    keyword index over chunk heading + text   ← keyword search
symbols       API names, each pointing at a chunk        ← symbol search, lookup_symbol
```

`chunks.id` is the shared key: a chunk's row in `chunks_vec` and in
`chunks_fts` uses the same id. That's why the three search lists can be merged
as plain lists of ids.

---

## The search path

Here is the example query from the `search_docs` tool description, run
against the real database and limited to the two Godot sources. To see this
breakdown for yourself, or for any other query:

```bash
yarn explain "move_and_slide floor detection" --sources godot-manual,godot-api
```

**Query:** `move_and_slide floor detection`

**1. The tool call arrives.** The server routes `/docs` to the docs endpoint;
`search_docs` validates the arguments with zod and calls `searchDocs`
([endpoint.ts:64](../src/docs/endpoint.ts#L64)).

**2. Split into terms** ([`queryTerms`](../src/docs/search.ts#L39)):
`["move_and_slide", "floor", "detection"]`. Stopwords ("how", "do", "I") are
dropped; identifier characters (`_ . # ::`) are kept so names stay whole. Only
`move_and_slide` looks like an identifier.

**3. Run three searches**, up to 50 candidates each. Top 5 of each:

| # | Vector (meaning) | Keyword (BM25) | Symbol |
|---|---|---|---|
| 1 | CharacterBody2D.is_on_floor | Using CharacterBody2D/3D › move_and_slide | **CharacterBody2D.move_and_slide** |
| 2 | CharacterBody3D.is_on_floor | CharacterBody2D.is_on_floor | CharacterBody3D.move_and_slide |
| 3 | CharacterBody3D.is_on_floor_only | CharacterBody3D.is_on_floor | |
| 4 | CharacterBody2D.is_on_floor_only | CharacterBody2D.get_floor_normal | |
| 5 | Using CharacterBody2D/3D › move_and_slide | CharacterBody3D.get_floor_normal | |

Notice that each list has a different idea of what matters. Vector search
latched onto "floor detection" and found `is_on_floor`, which is a good answer
to the intent. Keyword search found the tutorial with `move_and_slide` in its
heading. Only symbol search went straight to the method's own reference entry,
which the other two ranked 17th and 39th.

**4. Fuse.** The `CharacterBody2D.move_and_slide` method entry:

```
vector  rank 17   1/(60+17) = 0.0130
keyword rank 39   1/(60+39) = 0.0101
symbol  rank 1    1/(60+1)  = 0.0164
                              ──────
                              0.0395   ← highest of any chunk
```

`CharacterBody2D.is_on_floor` came 1st and 2nd in two lists: 1/61 + 1/62 =
0.0325. (This exact calculation is a test in
[search.test.ts](../src/docs/search.test.ts).)

**5. Cap per page and take the top 5.** Final results:

| Score | Result | Page |
|---|---|---|
| 0.0395 | CharacterBody2D.move_and_slide (method) | classes/class_characterbody2d.rst |
| 0.0325 | CharacterBody2D.is_on_floor (method) | classes/class_characterbody2d.rst |
| 0.0320 | CharacterBody3D.is_on_floor (method) | classes/class_characterbody3d.rst |
| 0.0315 | Using CharacterBody2D/3D › move_and_slide | tutorials/physics/using_character_body_2d.rst |
| 0.0308 | CharacterBody3D.is_on_floor_only (method) | classes/class_characterbody3d.rst |

The method itself, the floor check it pairs with, and the tutorial that
explains both. No single method found all three.

**6. Format.** Each result goes back to the assistant as markdown: heading,
source and path (so it can call `read_doc` for more), then the chunk text.
[`logged`](../src/endpoint.ts#L21) prints one line per call, which
`docker compose logs -f mcp` shows.

---

## When search gets it wrong

Fusion's bet ("agreement means relevance") is usually right, but not always.
A real example:

**Query:** `how do I make my character leap`

- Vector search ranks **Jumping and squashing monsters › Jumping** 1st. That's
  the right answer, despite sharing no words with the question.
- Keyword search can't connect "leap" to jumping. Its list fills with
  passages that match "make" and "character": "Character animation", even
  `String.replace_char`.
- Symbol search finds nothing.

"Jumping" gets 1/61 = 0.0164 from its single list. Meanwhile "Kinematic
character (2D) › Moving the kinematic character" is 10th by vector and 5th by
keyword: 1/70 + 1/65 = 0.0297. Two middling votes beat one strong one, and
**the right answer drops out of the top 5**.

`yarn explain "how do I make my character leap" --sources godot-manual,godot-api`
shows all of this.

This one is still open. Here's what was tried and why it didn't work. Each
attempt seemed reasonable, and each was ruled out by measurement:

- **Weight the vector list higher.** The weight boosts every chunk's vector
  score, including the noisy chunks that are also in the keyword list. Those
  still collect a second vote. Vector #1 would need about 7× weight to win,
  which amounts to dropping keyword search.
- **Require every query word, falling back to any word.** This helped short
  queries like this one. But real questions are 5–7 words after stopwords,
  and almost no passage contains them all, so on fresh questions it never
  triggered.
- **Drop keyword search when the query's rarest word isn't matched.** Rarity
  (IDF) does pick "leap" as the meaningful word. But "leap" *is* in the docs:
  24 passages, about other things. The rare word was found, in the wrong
  context. Keyword search sees words, not meaning, so it can't tell.

The standard fix is a **reranker**: a model that reads the question next to
each top candidate and rescores by actual relevance. Until then, hybrid is
still the best mode overall; the cost falls on questions phrased unlike the
docs.

Don't tune by intuition from one example. Measure:

```bash
yarn eval            # godot question set, top 5, each mode separately
yarn eval rails 5 hybrid
```

[eval.ts](../src/docs/eval/eval.ts) runs a fixed set of questions
([godot.json](../src/docs/eval/godot.json), [rails.json](../src/docs/eval/rails.json))
with known correct pages, and reports:

- **hit@k**: how often a correct page is in the top k.
- **MRR** (mean reciprocal rank): averages 1/rank of the first correct
  result, so 1.0 means always first.

Comparing `vector`, `fts` and `hybrid` on the same questions shows what each
method contributes. Change one thing, re-run, and compare.

**Beware tuning to the test.** If you try ten variants and keep whichever
scores best on these questions, you've partly fitted the questions.
[holdout.json](../src/docs/eval/holdout.json) holds paraphrase questions that
were written before any change was measured on them. Check a change there
before believing it (`yarn eval holdout 5 hybrid`). The "every word" attempt
above looked like an improvement on the main sets and did nothing on the
holdout.

Some question kinds track specific weak spots: `paraphrase` (the "leap"
problem above), `api-stopword` (`where` alone as a query), `api-question` (an
API name followed by `?`), and `api-predicate` (Ruby names that really end in
`?`, which those fixes must not break). The `markup` line counts results whose
heading still has RST markup. Saved runs in
[src/docs/eval/baselines/](../src/docs/eval/baselines/) record the numbers
before and after the fixes. To compare, save a new run next to them and diff
the two.

---

## The other tools

`search_docs` is the main tool. The other three serve narrower needs:

- **`list_docs`**: what's indexed ([endpoint.ts:115](../src/docs/endpoint.ts#L115)).
  The source ids also become an enum in the other tools' schemas, so the model
  sees valid values without calling this.
- **`lookup_symbol`**: exact API reference by name, no ranking involved
  ([endpoint.ts:144](../src/docs/endpoint.ts#L144)). It tries the exact name,
  then the name with its namespace left off, then a bare member, then a prefix.
  If many symbols match, it lists them instead of dumping them all. For a class,
  it also lists the class's members.
- **`read_doc`**: the whole page, or one section of it, when a chunk is cut off
  ([endpoint.ts:215](../src/docs/endpoint.ts#L215)). Long pages are truncated
  at 16,000 characters with an outline of section names.

---

## The server

[server.ts](../src/server.ts) is plain `node:http` with the MCP SDK's
transport:

- **Sessions.** A client's first request (no `mcp-session-id` header) gets a
  new transport and a new `McpServer`; the SDK assigns a session id, which the
  client sends on every later request
  ([server.ts](../src/server.ts), step 5 in `handle`). The database connection is shared
  across sessions.
- **DNS rebinding protection** ([`isAllowed`](../src/server.ts)). A
  malicious web page could point its own domain at 127.0.0.1 and have your
  browser call this server. Browsers send that domain in the `Host` header and
  add an `Origin` header; MCP clients don't. So requests are refused unless
  `Host` is one of ours and `Origin` is absent. The MCP spec requires this for
  local HTTP servers. `MCP_ALLOWED_HOSTS` adds the names used on the home
  network.
- **Bearer token** ([`isAuthorized`](../src/server.ts)). Every request must
  carry `Authorization: Bearer <MCP_TOKEN>`, local or not. The server can't
  reliably tell a local client from a network one: `Host` is set by the
  client, and Docker can rewrite the source address. So it doesn't try. The
  tokens are hashed before comparing so the check takes constant time.
- **Container hardening** ([docker-compose.yml](../docker-compose.yml)):
  read-only filesystem, no capabilities, ports bound to 127.0.0.1 (plus one
  LAN address if [docker-compose.lan.yml](../docker-compose.lan.yml) is
  enabled).

To add a new endpoint (a new set of tools at a new path), write a module that
implements the `Endpoint` interface ([src/endpoint.ts](../src/endpoint.ts))
and add it to the `endpoints` list in [server.ts](../src/server.ts).

---

## Things to try

The best way to build intuition is to poke at it.

- **Run the tests**, then read them as examples: `yarn test`. Change a
  constant (say `RRF_K` or the chunk size) and see which tests notice.
- **Explain a search**: `yarn explain "<query>"` prints each method's
  ranking, the fused scores and which list each one came from, and the final
  results ([explain.ts](../src/docs/eval/explain.ts)). Options:
  `--sources a,b`, `--top 15`, `--mode vector|fts|hybrid`. Try a question, an
  API name, and a question with an API name in it.
- **Try queries by hand** with the MCP Inspector:
  `npx @modelcontextprotocol/inspector@0.21.2 http://localhost:3939/docs`.
  Compare a "how do I" question, an exact API name and a misspelling.
- **Compare search modes** with `yarn eval godot 5 vector`, `… fts` and
  `… hybrid`, and read the misses each one lists.
- **Look inside the database** with any SQLite client (read-only is fine):
  ```sql
  SELECT name, kind, chunk_id FROM symbols WHERE name LIKE 'CharacterBody2D.%' LIMIT 20;
  SELECT heading, length(text) FROM chunks WHERE page_id = (SELECT id FROM pages WHERE path = 'classes/class_label.rst');
  ```
  The `chunks_vec` table needs the sqlite-vec extension loaded. The others
  don't.
- **Write a note** in `data/reference/` as markdown, run
  `yarn ingest reference`, and search for it.

---

## Further reading

**Start here**
- [MCP architecture overview](https://modelcontextprotocol.io/docs/learn/architecture)
- [The Illustrated Word2vec](https://jalammar.github.io/illustrated-word2vec/)
- [SBERT: Semantic Search](https://www.sbert.net/examples/applications/semantic-search/README.html)
- [Pinecone: Chunking Strategies](https://www.pinecone.io/learn/chunking-strategies/)

**Reference for the tools used here**
- [MCP spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) · [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [Inspector](https://github.com/modelcontextprotocol/inspector)
- [SQLite FTS5](https://www.sqlite.org/fts5.html) · [SQLite WAL mode](https://www.sqlite.org/wal.html)
- [sqlite-vec](https://alexgarcia.xyz/sqlite-vec/) ([vec0](https://alexgarcia.xyz/sqlite-vec/features/vec0.html), [KNN](https://alexgarcia.xyz/sqlite-vec/features/knn.html))
- [better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)
- [Ollama embed API](https://docs.ollama.com/api/embed) · [Qwen3-Embedding-4B](https://huggingface.co/Qwen/Qwen3-Embedding-4B)
- [Zod](https://zod.dev/)

**Go deeper**
- [Cormack, Clarke & Büttcher, *Reciprocal Rank Fusion*](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) (2009)
- [Robertson & Zaragoza, *The Probabilistic Relevance Framework: BM25 and Beyond*](https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf) (2009)
- [Qwen3 Embedding technical report](https://arxiv.org/abs/2506.05176) (2025)
- Manning, Raghavan & Schütze, *Introduction to Information Retrieval*,
  free online at nlp.stanford.edu/IR-book: the classic textbook for
  everything in the "Keyword search" and "Hybrid search" sections.
