# Limits and concurrency

githubDB trades latency for zero infrastructure. Know the envelope before depending on it.

## Latency

| Path | Latency |
|---|---|
| Write / query via Action | 10–30 s (workflow startup dominates) |
| Read via raw CDN (fast path) | < 1 s |

Use the [fast read path](api.html#fast-reads-without-the-action) for anything interactive; reserve Action queries for writes and occasional server-side SQL.

## Concurrency and consistency

- Queries against the **same database** run serially, enforced by a GitHub Actions concurrency group per database. Queued queries wait — they are never cancelled or lost.
- Queries against **different databases** run in parallel.
- Each query's changes are committed atomically — base file and shards together, all or nothing.
- If a push races with another commit, the engine pulls and re-executes, up to 3 attempts, then reports `ok: false`.
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
