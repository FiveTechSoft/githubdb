# githubDB Documentation

**A SQL + vector database that lives entirely in a GitHub repository. Fork it, and you have your own free database.**

githubDB turns a GitHub repository into a self-contained database system. Every file under `data/` is a database. The SQL engine runs inside GitHub Actions on your own fork — no servers, no hosting, no cost. Any language that can speak HTTP and JSON can use it.

> **Status: working preview.** The engine is functional and verified end-to-end — fork and try it. APIs may still change before 1.0.

## Contents

- [Getting started](getting-started.html) — fork, create a token, run your first query
- [API reference](api.html) — sending queries and reading results over HTTP
- [SQL reference](sql-reference.html) — supported statements, types, and parameters
- [Vector search](vectors.html) — `VECTOR(n)` columns, automatic embeddings, semantic search, fast RAG reads
- [Data format](data-format.html) — the JSON database file format and automatic sharding
- [Limits and concurrency](limits.html) — latency, size limits, consistency guarantees

## Why githubDB?

- **Fork = install.** Fork the repository and your database is ready. No configuration.
- **Zero cost.** Public repositories get unlimited free GitHub Actions minutes. The embedding model runs locally inside the Action — no API keys.
- **Real SQL.** Full CRUD plus DDL, including `JOIN`, `GROUP BY` and `ORDER BY`.
- **Built for AI.** Native vector columns, automatic embeddings, and a sub-second client-side read path for RAG.
- **Language-agnostic.** Plain HTTP + JSON. Python, JavaScript, Go, Harbour, curl — anything.
- **Version-controlled data.** Every change is a Git commit: full history, diffs, rollback.

## Repository

Source code and issue tracker: [github.com/FiveTechSoft/githubdb](https://github.com/FiveTechSoft/githubdb)
