---
title: Home
layout: default
nav_order: 1
permalink: /
---

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

> **Status: working preview.** The engine is functional and verified end-to-end — fork and try it. APIs may still change before 1.0.

## Why githubDB?

- **Fork = install.** Fork the repository and your database is ready. No configuration.
- **Zero cost.** Public repositories get unlimited free GitHub Actions minutes. The embedding model runs locally inside the Action — no API keys, no external services.
- **Real SQL.** `SELECT` with `WHERE`, `JOIN`, `GROUP BY`, `ORDER BY`, `LIMIT` — plus `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, `DROP TABLE`.
- **Built for AI.** Native `VECTOR(n)` columns, automatic embeddings, semantic search combined with relational filters, and a fast client-side read path for RAG (sub-second, no Action involved).
- **Language-agnostic.** The API is plain HTTP + JSON. Use it from Python, JavaScript, Go, Harbour, curl — anything.
- **Version-controlled data.** Every change to your data is a Git commit: full history, diffs, and rollback for free.

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

## Repository

Source code and issue tracker: [github.com/FiveTechSoft/githubdb](https://github.com/FiveTechSoft/githubdb)

## License

MIT
