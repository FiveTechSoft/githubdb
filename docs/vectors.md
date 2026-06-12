# Vector search

githubDB supports vector columns natively, with free automatic embeddings and SQL-composable similarity search. It is designed as a durable, versioned memory for AI agents and RAG applications.

## Declaring a vector column

```sql
CREATE TABLE docs (id INT, texto TEXT, embedding VECTOR(384))
```

or directly in the JSON file:

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

`VECTOR(n)` validates dimensions strictly on every write. Vectors are stored as base64-encoded float32 (little-endian) — roughly half the size of a JSON number array.

## Automatic embeddings (free)

If a table declares `"embed_from": "<text column>"`, then on `INSERT` or `UPDATE` any row whose vector column is `NULL` gets its embedding computed automatically from that text column.

- Model: **multilingual-e5-small** — 384 dimensions, strong multilingual quality (English, Spanish, and ~100 more languages).
- Runs **locally inside the GitHub Action** via transformers.js (ONNX). No API keys, no external calls, no cost.
- The model (~120 MB) is cached between workflow runs with `actions/cache`; after the first run it loads in seconds.

```sql
-- No vector supplied: the Action embeds 'texto' automatically
INSERT INTO docs (id, texto) VALUES (1, 'Cómo configurar el servidor SMTP')
```

## Bring your own embeddings

Send a precomputed vector and it is stored as-is — useful if you already use OpenAI, Voyage, or any other model. Declare the matching dimension:

```sql
CREATE TABLE notes (id INT, content TEXT, embedding VECTOR(1536))
```

```json
{
  "sql": "INSERT INTO notes VALUES (:id, :content, :vec)",
  "params": { "id": 1, "content": "...", "vec": "<base64 float32>" }
}
```

A non-`NULL` vector is never overwritten by auto-embedding.

## Semantic search in SQL

Vector functions compose with ordinary SQL — filter relationally, rank semantically:

```sql
SELECT id, texto, COSINE_SIM(embedding, EMBED('factura impagada')) AS score
FROM docs
WHERE category = 'contabilidad'
ORDER BY score DESC
LIMIT 10
```

Search is exact brute force with precomputed norms — at githubDB's practical scale (up to ~100k vectors of 384 dims) it completes in under a second inside the runner, with no index to maintain.

## Fast read path for RAG (sub-second, no Action)

Queries through the Action take 10–30 s — fine for writes, too slow for interactive retrieval. For reads, skip the Action entirely:

1. **Fetch the data directly** from the raw CDN (sub-second; no token needed on public repos):
   ```
   GET https://raw.githubusercontent.com/<OWNER>/githubdb/main/data/docs.json
   ```
   If the table is sharded, the base file's manifest lists the shard files to fetch.
2. **Embed the query locally.** transformers.js runs the same `multilingual-e5-small` model in Node and in the browser, free. (Or use your own model if you supplied your own vectors.)
3. **Compute similarity client-side** — a few lines of code over the decoded float32 arrays.

The result: an AI agent memory with **sub-second retrieval**, durable versioned writes, and zero infrastructure. Write paths (storing new memories) go through the Action; read paths (recall) never wait for one.

## Recommended patterns

| Use case | Pattern |
|---|---|
| Agent long-term memory | `docs(id, texto, metadata JSON, embedding VECTOR(384))` with `embed_from` |
| RAG knowledge base | Chunked documents, one row per chunk; client-side fast reads |
| Hybrid search | `WHERE` filters on metadata + `ORDER BY COSINE_SIM(...) DESC` |
| Multi-model setup | Separate tables per embedding model, each with its own `VECTOR(n)` |
