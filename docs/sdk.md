---
title: SDKs
layout: default
parent: Home
nav_order: 5
---

# SDKs — fast read path

Official client SDKs for **JavaScript**, **Python** and **PHP**. They implement the [fast read path]({% link vectors.md %}#fast-read-path-for-rag-sub-second-no-action): data is fetched directly from GitHub's raw CDN (sub-second, no Action involved), vectors are decoded client-side, and semantic search runs locally. A `query()` convenience for writes (dispatch + poll) is also included.

All three SDKs share the same semantics:

- `table(db, name)` — fetch a table (base file + shards, merged transparently, cached per instance)
- `objects()` — rows as objects/dicts/assoc arrays
- `search(query, ...)` — semantic search: pass a **text** (embedded locally with `multilingual-e5-small`, optional dependency) or a **precomputed vector** (array or base64); supports `limit` and a `where` pre-filter
- `refresh(db)` — drop the cache and refetch
- `query(db, sql, params)` — send SQL through the Action (requires a token; 10–30 s)

Embedding model dependencies are **optional**: without them, `search(vector)` always works and `search(text)` raises an instructive error. Private repos: pass a `token` and reads go through the GitHub contents API instead of the public CDN.

## JavaScript (Node 18+ and browsers)

```bash
npm install FiveTechSoft/githubdb#main --workspace … # or copy sdk/js
# optional, for local text embedding:
npm install @huggingface/transformers
```

```js
import { GithubDB } from './sdk/js/src/index.js';

const gdb = new GithubDB({ owner: 'YOU' });

const docs = await gdb.table('example', 'docs');
console.log(docs.objects());

// semantic search — embeds locally, <1s after model warm-up
const hits = await docs.search('mi correo no funciona', { limit: 5 });
for (const { row, score } of hits) console.log(score.toFixed(3), row.texto);

// with a precomputed vector (no embedding dependency needed)
const hits2 = await docs.search([0.1, -0.2 /* …384 dims */], { limit: 5 });

// writes (requires token)
const gdbW = new GithubDB({ owner: 'YOU', token: process.env.GITHUB_TOKEN });
await gdbW.query('example', 'INSERT INTO docs (id, texto) VALUES (:id, :t)',
                 { id: 7, t: 'nuevo documento' });
```

## Python (3.9+)

```bash
pip install "git+https://github.com/YOU/githubdb#subdirectory=sdk/python"
# optional, for local text embedding:
pip install sentence-transformers
```

```python
from githubdb_sdk import GithubDB

gdb = GithubDB("YOU")

docs = gdb.table("example", "docs")
print(docs.objects())

hits = docs.search("mi correo no funciona", limit=5)
for h in hits:
    print(round(h["score"], 3), h["row"]["texto"])

# precomputed vector
hits2 = docs.search([0.1, -0.2, ...], limit=5)

# writes (requires token)
gdb_w = GithubDB("YOU", token=os.environ["GITHUB_TOKEN"])
gdb_w.query("example", "INSERT INTO docs (id, texto) VALUES (:id, :t)",
            params={"id": 7, "t": "nuevo documento"})
```

## PHP (8.1+)

```bash
composer require githubdb/sdk   # or copy sdk/php and include src/autoload.php
# optional, for local text embedding:
composer require codewithkyrian/transformers
```

```php
require 'sdk/php/src/autoload.php';

use GithubDB\GithubDB;

$gdb = new GithubDB('YOU');

$docs = $gdb->table('example', 'docs');
print_r($docs->objects());

$hits = $docs->search('mi correo no funciona', limit: 5);
foreach ($hits as $h) {
    printf("%.3f %s\n", $h['score'], $h['row']['texto']);
}

// precomputed vector
$hits2 = $docs->search([0.1, -0.2, /* …384 dims */], limit: 5);

// writes (requires token)
$gdbW = new GithubDB('YOU', token: getenv('GITHUB_TOKEN'));
$gdbW->query('example', 'INSERT INTO docs (id, texto) VALUES (:id, :t)',
             ['id' => 7, 't' => 'nuevo documento']);
```

## Embedding consistency

The engine embeds stored documents with the `passage: ` prefix; the SDKs embed your search text with the `query: ` prefix — the asymmetric-retrieval convention of the e5 model family. If you store your own vectors (e.g. OpenAI), pass the matching query vectors to `search()` and ignore the built-in embedders.

## Error reference

| Case | Error message |
|---|---|
| Unknown database | `Database '<db>' not found` |
| Unknown table | `Table '<t>' not found in database '<db>'` |
| No vector column | `Table '<t>' has no VECTOR column` |
| Dimension mismatch | `Vector dimension mismatch: expected N, got M` |
| Embedding dep missing | Instructive message with the install command |
| `query()` without token | `A token is required to send queries` |
