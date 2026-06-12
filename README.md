# githubDB

**A SQL + vector database that lives entirely in a GitHub repository. Fork it, and you have your own free database.**

githubDB turns a GitHub repository into a self-contained database system. Every file under `data/` is a database. The SQL engine runs inside GitHub Actions on your own fork — no servers, no hosting, no cost. Any language that can speak HTTP and JSON can use it.

```sql
SELECT id, texto, COSINE_SIM(embedding, EMBED('unpaid invoice')) AS score
FROM docs
WHERE category = 'accounting'
ORDER BY score DESC
LIMIT 10
```

> **Status: working preview.** The engine is functional and verified end-to-end — fork and try it. APIs may still change before 1.0. ([design spec](docs/superpowers/specs/2026-06-12-githubdb-design.md))

**📖 Documentation: [fivetechsoft.github.io/githubdb](https://fivetechsoft.github.io/githubdb/)**

## Why githubDB?

- **Fork = install.** Fork this repository and your database is ready. No configuration required.
- **Zero cost.** Public repositories get unlimited free GitHub Actions minutes (private repos: 2,000 min/month free). The embedding model runs locally inside the Action — no API keys, no external services.
- **Real SQL.** `SELECT` with `WHERE`, `JOIN`, `GROUP BY`, `ORDER BY`, `LIMIT` — plus `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, `DROP TABLE`.
- **Built for AI.** Native `VECTOR(n)` columns, automatic embeddings, semantic search combined with relational filters, and a fast client-side read path for RAG (sub-second, no Action involved).
- **Language-agnostic.** The API is plain HTTP + JSON. Use it from Python, JavaScript, Go, Harbour, curl — anything.
- **Version-controlled data.** Every change to your data is a Git commit. Full history, diffs, and rollback for free.

## How it works

```
Client (any language)
  │  POST api.github.com/repos/YOU/githubdb/dispatches
  │    { "event_type": "query",
  │      "client_payload": { "id": "<uuid>", "db": "example",
  │                          "sql": "INSERT INTO clients VALUES (1, 'Ana')" } }
  ▼
GitHub Action (inside your fork)
  │  loads data/example.json
  │  executes the SQL (alasql engine)
  │  commits modified data files
  │  writes results/<uuid>.json
  ▼
Client polls raw.githubusercontent.com/YOU/githubdb/main/results/<uuid>.json
```

1. Your client sends a query through GitHub's `repository_dispatch` API, including a unique query `id`.
2. A GitHub Actions workflow wakes up, runs the SQL against the JSON data files, and commits any changes.
3. The result is written to `results/<id>.json`. Your client polls that file through GitHub's raw CDN until it appears (recommended: every 3 s, 120 s timeout).

Every query that carries a valid `id` always produces a result file — `{"ok": true, ...}` with rows, or `{"ok": false, "error": "..."}` on failure. Clients never hang on a bad query.

## Quick start

1. **Fork this repository.**
2. **Create a token.** A [fine-grained personal access token](https://github.com/settings/personal-access-tokens) with `Contents: Read and write` on your fork.
3. **Send your first query:**

```bash
ID=$(uuidgen)
curl -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/YOU/githubdb/dispatches \
  -d "{\"event_type\":\"query\",\"client_payload\":{\"id\":\"$ID\",\"db\":\"example\",\"sql\":\"SELECT * FROM clients\"}}"

# Poll for the result
curl -s "https://raw.githubusercontent.com/YOU/githubdb/main/results/$ID.json"
```

Ready-to-run client examples for several languages live in [`clients/`](clients/).

## Data model

One database = one JSON file under `data/`. Human-readable, diff-friendly, hand-editable.

```json
{
  "githubdb": 1,
  "tables": {
    "clients": {
      "columns": [
        { "name": "id",    "type": "INT"  },
        { "name": "name",  "type": "TEXT" },
        { "name": "email", "type": "TEXT" }
      ],
      "rows": [
        [1, "Ana",  "ana@mail.com"],
        [2, "Luis", "luis@mail.com"]
      ]
    }
  }
}
```

Supported column types: `INT`, `FLOAT`, `TEXT`, `BOOL`, `JSON`, `VECTOR(n)`. Typing is permissive (SQLite-style), except `VECTOR(n)`, which validates dimensions strictly.

### Automatic sharding

When a database file would exceed **40 MB**, the engine transparently moves rows into numbered shard files (`example.001.json`, `example.002.json`, …) and keeps a manifest in the base file. SQL queries are unaffected — the engine merges shards at load time. This keeps every file safely under GitHub's 100 MB hard limit.

## Vector search for AI

Declare a vector column, optionally tell githubDB which text column to embed from, and you have a free semantic search engine:

```json
"docs": {
  "columns": [
    { "name": "id",        "type": "INT" },
    { "name": "texto",     "type": "TEXT" },
    { "name": "embedding", "type": "VECTOR(384)" }
  ],
  "embed_from": "texto"
}
```

- **Automatic embeddings.** On `INSERT`/`UPDATE`, if the vector column is `NULL`, the Action generates the embedding using `multilingual-e5-small` (384 dims, strong multilingual support) running locally via transformers.js. The model is cached between runs. No API keys, no cost.
- **Bring your own vectors.** Send a precomputed embedding (e.g. OpenAI, 1536 dims) and it is stored as-is — declare the matching `VECTOR(n)` size.
- **SQL functions.** `COSINE_SIM(col, v)`, `DOT_PRODUCT(col, v)`, `EUCLIDEAN(col, v)`, and `EMBED(text)` — composable with regular `WHERE` filters, `ORDER BY`, and `LIMIT`.
- **Compact storage.** Vectors are stored as base64-encoded float32, roughly half the size of JSON number arrays.

### Fast read path for RAG (no Action, sub-second)

Writes go through Actions, but reads don't have to. For retrieval-augmented generation:

1. Fetch `data/<db>.json` (plus shards) directly from `raw.githubusercontent.com` — CDN latency, no workflow.
2. Embed the query locally (transformers.js runs the same model in Node and browsers) or with your own model.
3. Compute similarity client-side.

This gives AI agents a free, versioned memory with sub-second retrieval and durable, auditable writes.

## Concurrency and consistency

- Queries run as parallel workflow runs and **serialize through Git**: on a push conflict the engine pulls the fresh data, re-executes the query, and pushes again (up to 5 attempts with randomized backoff). No query is silently dropped.
- All file changes from one query land in a single atomic commit.
- Under sustained heavy write contention a run can exhaust its retries; the workflow run is marked failed and the query can simply be re-sent.

## Limitations (read before depending on it)

| Limitation | Detail |
|---|---|
| Write latency | 10–30 s per query via Actions (use the fast read path for reads) |
| Throughput | Bounded by GitHub API rate limits (~5,000 req/h per token) |
| Size | Practical limit of a few hundred MB per repository |
| Transactions | Single-query atomicity only; no multi-query transactions |
| **Privacy** | **In a public fork, your data is public.** Use a private fork for anything sensitive |

githubDB is ideal for: agent memory, RAG knowledge bases, configuration stores, small-team datasets, prototypes, and any dataset that benefits from version history. It is not a replacement for Postgres.

## Testing

githubDB is tested at four levels. All results below are from real runs (2026-06-12).

### Unit tests — 43 tests

```bash
npm test --prefix engine
```

| Module | Coverage |
|---|---|
| `vectors.js` | base64-float32 round-trip, dimension validation, cosine/dot/euclidean known values, mismatched lengths |
| `storage.js` | load with shard merging, missing-database and format-version errors, name validation (path traversal, regex injection), sharding at threshold, shard size limits with long table names, stale-shard cleanup, round-trips |
| `sql.js` | CREATE/DROP TABLE with `VECTOR(n)`, SELECT/INSERT/UPDATE/DELETE, JOIN + GROUP BY, named parameters (including `:param` inside string literals and `::` casts), reserved-word identifiers, vector functions, dimension validation with rollback, auto-embed, EMBED(), client-vector override |
| `run-query.js` | result files for success/error paths, data persistence, CREATE-on-missing-database, missing-id no-op, result cleanup by age |

### Stress tests — 18 tests

```bash
npm run test:stress --prefix engine
```

Deterministic (seeded PRNG), with independently computed expected values:

| Test | Scale | Observed |
|---|---|---|
| Brute-force cosine search, top-10 | 100,000 × 384-dim vectors | 951 ms |
| Vector encode+decode round-trip | 10,000 × 384 dims | 196 ms |
| Sharded save+load round-trip | 100,000 rows | 252 ms |
| 50 tables × 2,000 rows integrity | 100,000 rows | 79 ms |
| SELECT + WHERE + ORDER BY + LIMIT | 100,000 rows | 70 ms |
| JOIN + GROUP BY (verified aggregate) | 10k × 10k | 18 ms |
| 1,000 sequential INSERTs | growing DB | 523 ms |
| UPDATE hitting 50,000 of 100,000 rows | 100,000 rows | 63 ms |
| `COSINE_SIM` ORDER BY through SQL | 20,000 × VECTOR(64) | 146 ms |

Plus edge cases: unicode/emoji, quotes and SQL-escaping, `0`/`false`/`''`/`null` round-trips, 100-column tables, 10 KB cells, DROP+CREATE same name, 1,000-file result cleanup.

### End-to-end (real GitHub, this repository)

- `SELECT` via `repository_dispatch` → result file in ~25 s, engine time 24 ms.
- `INSERT` without a vector → Action auto-embedded with the local model and committed the 384-dim embedding (3.3 s engine time, model cached between runs).
- Semantic search: `COSINE_SIM(embedding, EMBED('mi correo electrónico no funciona'))` correctly ranked an SMTP-configuration document above an unrelated one.

### Concurrency stress (real GitHub)

5 simultaneous `INSERT`s into the same database:

- **Found a real bug:** the original design used a GitHub Actions concurrency group per database, assuming queued queries wait. In reality GitHub keeps at most 1 running + 1 pending run per group and **cancels** the rest — 3 of 5 queries were silently lost.
- **Fix:** the concurrency group was removed; runs execute in parallel and serialize through Git (push conflict → pull fresh data → re-execute → push, up to 5 attempts with randomized backoff).
- **Re-test after the fix: 5/5 runs succeeded, 5/5 rows landed, 0 queries lost.**

## Repository layout

```
data/                  Your databases (JSON)
results/               Query results, auto-cleaned after 1 hour
engine/                The SQL + vector engine (Node.js, runs in Actions)
.github/workflows/     The query workflow (repository_dispatch)
clients/               Client examples: curl, Python, JavaScript
docs/                  Design documents
```

## License

MIT

---

*Built by [FiveTech Software](https://github.com/FiveTechSoft).*
