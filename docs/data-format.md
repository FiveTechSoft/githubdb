---
title: Data format
layout: default
parent: Home
nav_order: 6
---

# Data format

One database = one JSON file under `data/`. Files are plain, human-readable JSON — you can create and edit them by hand, through Git, or through SQL.

## Database file

`data/example.json`:

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
    },
    "docs": {
      "columns": [
        { "name": "id",        "type": "INT" },
        { "name": "texto",     "type": "TEXT" },
        { "name": "embedding", "type": "VECTOR(384)" }
      ],
      "embed_from": "texto",
      "shards": ["example.001.json"],
      "rows": []
    }
  }
}
```

| Field | Description |
|---|---|
| `githubdb` | Format version (currently `1`), reserved for future migrations |
| `tables.<name>.columns` | Ordered column definitions: `name` + `type` |
| `tables.<name>.rows` | Row data as arrays, in column order |
| `tables.<name>.embed_from` | Optional: text column used for automatic embeddings |
| `tables.<name>.shards` | Optional: shard files holding additional rows |

Rows are arrays (not objects) to keep files compact and diffs readable.

## Automatic sharding

GitHub rejects files over 100 MB. githubDB never lets a data file get near that:

- When saving would push a file past **40 MB**, the engine moves rows into a new shard file: `example.001.json`, `example.002.json`, …
- A shard contains only rows: `{ "table": "docs", "rows": [...] }`.
- The base file keeps the manifest (`shards`) per table; small tables stay inline.
- Reading is transparent: the engine (and the documented fast-read path) merges inline rows with all shard rows.
- A single query's changes — base file plus any shards — land in **one atomic commit**.

## Editing data by hand

Because databases are plain JSON in Git, you can:

- Edit rows in the GitHub web editor or any text editor and commit.
- Review data changes in pull requests, with line-by-line diffs.
- Roll back any change with `git revert`.
- Bulk-load data by committing a generated JSON file directly — no need to send thousands of `INSERT`s.

The only rule: keep the structure above valid. The engine validates on load and reports malformed files as query errors.

## Size guidance

| Layer | Limit |
|---|---|
| Single file | 40 MB (githubDB shard threshold; GitHub warns at 50 MB, rejects at 100 MB) |
| Repository | A few hundred MB practical; GitHub recommends < 1 GB |
| Vectors | 384-dim ≈ 2 KB per row (base64 float32) |
