---
title: Getting started
layout: default
parent: Home
nav_order: 1
---

# Getting started

## 1. Fork the repository

Fork [FiveTechSoft/githubdb](https://github.com/FiveTechSoft/githubdb) into your account. Your fork **is** your database installation — the engine, the workflow, and your data all live inside it.

If you plan to store anything sensitive, make your fork **private** (GitHub → Settings → change visibility). In a public fork, your data is readable by anyone.

## 2. Create an access token

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens) with access to your fork and these permissions:

| Permission | Level |
|---|---|
| Contents | Read and write |
| Metadata | Read |

A classic token with the `repo` scope also works.

## 3. Send your first query

Queries are sent through GitHub's `repository_dispatch` API. Each query carries a unique `id` that you generate (a UUID is recommended) — the result will be published under that id.

```bash
ID=$(uuidgen)

curl -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/YOU/githubdb/dispatches \
  -d "{
    \"event_type\": \"query\",
    \"client_payload\": {
      \"id\": \"$ID\",
      \"db\": \"example\",
      \"sql\": \"SELECT * FROM clients\"
    }
  }"
```

## 4. Read the result

The Action writes the result to `results/<id>.json`. Poll it through GitHub's raw CDN:

```bash
curl -s "https://raw.githubusercontent.com/YOU/githubdb/main/results/$ID.json"
```

Recommended polling: every 3 seconds, with a 120-second timeout. A successful result looks like:

```json
{
  "ok": true,
  "id": "8c1f...",
  "rowCount": 2,
  "columns": ["id", "name"],
  "rows": [[1, "Ana"], [2, "Luis"]],
  "elapsedMs": 840
}
```

On failure you get `{"ok": false, "error": "..."}` — every query with a valid `id` always produces a result file, so clients never hang on a bad query.

## 5. Create your own database

Create a table in a new database with a single query — the database file is created automatically:

```sql
CREATE TABLE clients (id INT, name TEXT, email TEXT)
```

sent with `"db": "mydb"` creates `data/mydb.json` with the `clients` table. Then insert and query:

```sql
INSERT INTO clients VALUES (1, 'Ana', 'ana@mail.com')
SELECT * FROM clients WHERE id = 1
```

You can also create or edit `data/*.json` files by hand or through Git — they are plain, human-readable JSON. See [Data format]({% link data-format.md %}).

## Next steps

- [API reference]({% link api.md %}) — payload fields, parameters, result format
- [Vector search]({% link vectors.md %}) — add semantic search with automatic embeddings
- Client examples in [`clients/`](https://github.com/FiveTechSoft/githubdb/tree/main/clients) — curl, Python, JavaScript
