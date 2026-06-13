---
title: SQL reference
layout: default
parent: Home
nav_order: 3
---

# SQL reference

The engine executes SQL with [alasql](https://github.com/alasql/alasql) over the JSON data files, extended with vector functions. One statement per query.

## Supported statements

### SELECT

```sql
SELECT id, name FROM clients WHERE id > :min ORDER BY name LIMIT 10
SELECT c.name, SUM(o.total) AS total
FROM clients c JOIN orders o ON o.client_id = c.id
GROUP BY c.name
HAVING SUM(o.total) > 100
```

Supported: `WHERE`, `JOIN` (inner/left), `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`/`OFFSET`, `DISTINCT`, aggregate functions (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`), subqueries, `UNION`.

### INSERT

```sql
INSERT INTO clients VALUES (1, 'Ana', 'ana@mail.com')
INSERT INTO clients (id, name) VALUES (:id, :name)
```

### UPDATE

```sql
UPDATE clients SET email = :email WHERE id = :id
```

### DELETE

```sql
DELETE FROM clients WHERE id = :id
```

### CREATE TABLE / DROP TABLE

```sql
CREATE TABLE docs (id INT, texto TEXT, embedding VECTOR(384))
DROP TABLE docs
```

`CREATE TABLE` on a database that does not exist yet creates the database file automatically.

## Column types

| Type | Notes |
|---|---|
| `INT` | |
| `FLOAT` | |
| `TEXT` | |
| `BOOL` | |
| `JSON` | Arbitrary nested JSON values |
| `VECTOR(n)` | Embedding of `n` float32 dimensions; strictly validated |

Typing is permissive, SQLite-style: values are stored as sent and types are advisory — except `VECTOR(n)`, which validates dimensions on every write.

## Named parameters

Reference parameters in SQL as `:name` and pass values in `client_payload.params`:

```json
{
  "sql": "SELECT * FROM docs WHERE category = :cat AND COSINE_SIM(embedding, :vec) > 0.7",
  "params": {
    "cat": "manuals",
    "vec": [0.011, -0.082, 0.034]
  }
}
```

Parameters avoid SQL injection and quoting issues — always prefer them over string interpolation.

## Vector functions

| Function | Returns |
|---|---|
| `COSINE_SIM(col, v)` | Cosine similarity, −1…1 (1 = identical direction) |
| `DOT_PRODUCT(col, v)` | Dot product |
| `EUCLIDEAN(col, v)` | Euclidean distance (0 = identical) |
| `EMBED(text)` | 384-dim embedding of `text`, computed with the built-in local model |

`v` may be a named parameter (base64 float32 string or JSON number array) or an `EMBED(...)` call. See [Vector search]({% link vectors.md %}) for the full picture.

```sql
SELECT id, texto, COSINE_SIM(embedding, EMBED('unpaid invoice')) AS score
FROM docs
WHERE category = 'accounting'
ORDER BY score DESC
LIMIT 10
```
