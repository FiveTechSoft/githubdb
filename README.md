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

> **Status: under development.** The design is complete ([design spec](docs/superpowers/specs/2026-06-12-githubdb-design.md)); the engine is being implemented. Watch the repo for the first release.

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

- Queries against the **same database** run serially (GitHub Actions concurrency groups) — no commit conflicts, no lost updates. Queued queries wait; they are never cancelled.
- Queries against **different databases** run in parallel.
- All file changes from one query land in a single atomic commit.
- On push races, the engine retries (pull + re-execute) up to 3 times.

## Limitations (read before depending on it)

| Limitation | Detail |
|---|---|
| Write latency | 10–30 s per query via Actions (use the fast read path for reads) |
| Throughput | Bounded by GitHub API rate limits (~5,000 req/h per token) |
| Size | Practical limit of a few hundred MB per repository |
| Transactions | Single-query atomicity only; no multi-query transactions |
| **Privacy** | **In a public fork, your data is public.** Use a private fork for anything sensitive |

githubDB is ideal for: agent memory, RAG knowledge bases, configuration stores, small-team datasets, prototypes, and any dataset that benefits from version history. It is not a replacement for Postgres.

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
