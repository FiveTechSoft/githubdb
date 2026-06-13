---
title: Limits & concurrency
layout: default
parent: Home
nav_order: 7
---

# Limits and concurrency

githubDB trades latency for zero infrastructure. Know the envelope before depending on it.

## Latency

| Path | Latency |
|---|---|
| Write / query via Action | 10–30 s (workflow startup dominates) |
| Read via raw CDN (fast path) | < 1 s |

Use the [fast read path]({% link api.md %}#fast-reads-without-the-action) for anything interactive; reserve Action queries for writes and occasional server-side SQL.

## Concurrency and consistency

- All queries run as parallel workflow runs and **serialize through Git**: each run commits its changes and pushes; if the push conflicts with a concurrent query, the engine resets, pulls the fresh data, **re-executes the query**, and pushes again (up to 5 attempts with randomized backoff).
- This guarantees no query is silently dropped. (GitHub Actions concurrency groups are deliberately *not* used: GitHub keeps at most one pending run per group and cancels the rest, which would lose queries.)
- Each query's changes are committed atomically — base file and shards together, all or nothing.
- Under sustained heavy write contention a run can exhaust its 5 attempts and fail; the workflow run is marked failed and the query can be re-sent.
- There are **no multi-query transactions**: each query is its own atomic unit.

## Throughput

- GitHub API: ~5,000 authenticated requests/hour per token (dispatch calls). Raw CDN polling does not count.
- Actions minutes: unlimited on public repositories; 2,000 min/month free on private ones. A typical query consumes well under one minute.
- githubDB is built for low write frequency — agent memories, knowledge bases, configuration, small-team data. Not for hundreds of writes per minute.

## Size

- Files: sharded automatically at 40 MB (GitHub hard limit: 100 MB).
- Repository: practical limit of a few hundred MB; GitHub recommends staying under 1 GB.
- Brute-force vector search stays sub-second up to roughly 100k × 384-dim vectors.

## Privacy

**In a public fork, your data is public** — readable by anyone, no token required. Use a private fork for anything sensitive. Tokens grant access at repository level; there is no row- or table-level access control.

## Result files

Query results live in `results/<id>.json` and are deleted automatically after one hour. Treat them as a transport, not as storage.
