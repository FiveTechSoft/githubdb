# githubDB Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the githubDB engine: SQL + vector queries over JSON files in the repo, executed by a GitHub Actions workflow triggered via `repository_dispatch`.

**Architecture:** A Node.js engine (`engine/`) loads `data/<db>.json` (+ shards), executes one SQL statement with alasql (DDL handled by a small built-in parser, vector functions registered as custom alasql functions), auto-embeds `VECTOR` columns with a local transformers.js model, saves data with automatic sharding, and writes `results/<id>.json`. A workflow (`.github/workflows/query.yml`) wires it to `repository_dispatch` with per-database concurrency and a commit/push retry loop.

**Tech Stack:** Node.js 20+ (ESM), alasql, @huggingface/transformers (transformers.js), node:test, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-06-12-githubdb-design.md`

## File structure

```
engine/
├─ package.json          # ESM, deps: alasql, @huggingface/transformers
├─ vectors.js            # base64-float32 codec + similarity math
├─ storage.js            # load/save databases (sharding), results I/O, cleanup
├─ sql.js                # statement routing, alasql execution, vector fns, auto-embed
├─ embed.js              # local embedding model wrapper (lazy-loaded)
├─ run-query.js          # Action entry point: payload → result file
└─ test/
   ├─ vectors.test.js
   ├─ storage.test.js
   ├─ sql.test.js
   └─ run-query.test.js
.github/workflows/query.yml
data/example.json
clients/curl.sh  clients/python.py  clients/javascript.js
LICENSE
```

Module boundaries: `vectors.js` is pure math/codec (no I/O). `storage.js` is pure file I/O (no SQL). `sql.js` is pure in-memory execution (no file I/O — takes/returns the db object). `run-query.js` is the only orchestrator. `embed.js` is the only module that touches the ML model; everything else receives embed functions by injection so tests can mock them.

---

### Task 1: Engine scaffold

**Files:**
- Create: `engine/package.json`
- Create: `.gitignore`

- [ ] **Step 1: Create `engine/package.json`**

```json
{
  "name": "githubdb-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/"
  },
  "dependencies": {
    "alasql": "^4.6.0",
    "@huggingface/transformers": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore` at repo root**

```
node_modules/
```

- [ ] **Step 3: Install dependencies**

Run: `npm install --prefix engine`
Expected: `package-lock.json` created, no errors.

- [ ] **Step 4: Commit**

```bash
git add engine/package.json engine/package-lock.json .gitignore
git commit -m "feat: scaffold engine package"
```

---

### Task 2: Vector codec and similarity (`vectors.js`)

**Files:**
- Create: `engine/vectors.js`
- Test: `engine/test/vectors.test.js`

- [ ] **Step 1: Write failing tests**

```js
// engine/test/vectors.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeVector, decodeVector, toVector,
  cosineSim, dotProduct, euclidean
} from '../vectors.js';

test('encode/decode round-trip preserves float32 values', () => {
  const v = [0.25, -1.5, 3.0];
  const b64 = encodeVector(v);
  assert.equal(typeof b64, 'string');
  assert.deepEqual(Array.from(decodeVector(b64)), v);
});

test('decodeVector validates dimensions', () => {
  const b64 = encodeVector([1, 2, 3]);
  assert.throws(() => decodeVector(b64, 4), /expected 4, got 3/);
});

test('toVector accepts base64, array and Float32Array', () => {
  const arr = [1, 0, 0];
  assert.deepEqual(Array.from(toVector(encodeVector(arr))), arr);
  assert.deepEqual(Array.from(toVector(arr)), arr);
  assert.deepEqual(Array.from(toVector(Float32Array.from(arr))), arr);
  assert.throws(() => toVector(42), /Invalid vector/);
  assert.throws(() => toVector(arr, 4), /expected 4, got 3/);
});

test('cosineSim of identical vectors is 1, orthogonal is 0', () => {
  const a = Float32Array.from([1, 0]);
  const b = Float32Array.from([0, 1]);
  assert.ok(Math.abs(cosineSim(a, a) - 1) < 1e-6);
  assert.ok(Math.abs(cosineSim(a, b)) < 1e-6);
});

test('dotProduct and euclidean known values', () => {
  const a = Float32Array.from([1, 2]);
  const b = Float32Array.from([3, 4]);
  assert.equal(dotProduct(a, b), 11);
  assert.ok(Math.abs(euclidean(a, b) - Math.sqrt(8)) < 1e-6);
});

test('similarity functions reject mismatched lengths', () => {
  const a = Float32Array.from([1, 2]);
  const b = Float32Array.from([1, 2, 3]);
  assert.throws(() => cosineSim(a, b), /dimension/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix engine`
Expected: FAIL — `Cannot find module '../vectors.js'`

- [ ] **Step 3: Implement `engine/vectors.js`**

```js
// engine/vectors.js
// Vectors are stored in cells as base64-encoded little-endian float32.

export function encodeVector(values) {
  const f = Float32Array.from(values);
  return Buffer.from(f.buffer, 0, f.byteLength).toString('base64');
}

export function decodeVector(b64, dims) {
  const buf = Buffer.from(b64, 'base64');
  const n = buf.byteLength / 4;
  if (dims !== undefined && n !== dims) {
    throw new Error(`Vector dimension mismatch: expected ${dims}, got ${n}`);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, n);
}

export function toVector(value, dims) {
  if (typeof value === 'string') return decodeVector(value, dims);
  if (Array.isArray(value) || value instanceof Float32Array) {
    if (dims !== undefined && value.length !== dims) {
      throw new Error(`Vector dimension mismatch: expected ${dims}, got ${value.length}`);
    }
    return Float32Array.from(value);
  }
  throw new Error('Invalid vector value: expected base64 string or number array');
}

function checkSameLength(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
}

export function dotProduct(a, b) {
  checkSameLength(a, b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function cosineSim(a, b) {
  checkSameLength(a, b);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function euclidean(a, b) {
  checkSameLength(a, b);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix engine`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add engine/vectors.js engine/test/vectors.test.js
git commit -m "feat: vector base64-float32 codec and similarity functions"
```

---

### Task 3: Database loading with shards (`storage.js`, part 1)

**Files:**
- Create: `engine/storage.js`
- Test: `engine/test/storage.test.js`

- [ ] **Step 1: Write failing tests**

```js
// engine/test/storage.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatabase, saveDatabase } from '../storage.js';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'githubdb-'));
});

const baseDb = () => ({
  githubdb: 1,
  tables: {
    clients: {
      columns: [
        { name: 'id', type: 'INT' },
        { name: 'name', type: 'TEXT' }
      ],
      rows: [[1, 'Ana'], [2, 'Luis']]
    }
  }
});

test('loadDatabase reads a simple database', async () => {
  await writeFile(join(dir, 'mydb.json'), JSON.stringify(baseDb()));
  const db = await loadDatabase(dir, 'mydb');
  assert.equal(db.tables.clients.rows.length, 2);
});

test('loadDatabase merges shard rows after inline rows', async () => {
  const db = baseDb();
  db.tables.clients.shards = ['mydb.001.json'];
  await writeFile(join(dir, 'mydb.json'), JSON.stringify(db));
  await writeFile(join(dir, 'mydb.001.json'),
    JSON.stringify({ table: 'clients', rows: [[3, 'Eva']] }));
  const loaded = await loadDatabase(dir, 'mydb');
  assert.deepEqual(loaded.tables.clients.rows, [[1, 'Ana'], [2, 'Luis'], [3, 'Eva']]);
});

test('loadDatabase throws clear error for missing database', async () => {
  await assert.rejects(loadDatabase(dir, 'nope'), /Database 'nope' not found/);
});

test('loadDatabase rejects unknown format version', async () => {
  await writeFile(join(dir, 'bad.json'), JSON.stringify({ githubdb: 99, tables: {} }));
  await assert.rejects(loadDatabase(dir, 'bad'), /format version/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix engine`
Expected: FAIL — `Cannot find module '../storage.js'`

- [ ] **Step 3: Implement loading in `engine/storage.js`**

```js
// engine/storage.js
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_SHARD_THRESHOLD = 40 * 1024 * 1024; // 40 MB

export async function loadDatabase(dataDir, name) {
  const path = join(dataDir, `${name}.json`);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`Database '${name}' not found`);
    throw e;
  }
  const db = JSON.parse(raw);
  if (db.githubdb !== 1) {
    throw new Error(`Unsupported format version in database '${name}'`);
  }
  for (const table of Object.values(db.tables)) {
    if (table.shards) {
      for (const shardFile of table.shards) {
        const shard = JSON.parse(await readFile(join(dataDir, shardFile), 'utf8'));
        table.rows = table.rows.concat(shard.rows);
      }
      delete table.shards; // in-memory model is always merged; saveDatabase re-shards
    }
  }
  return db;
}
```

- [ ] **Step 4: Run tests to verify load tests pass**

Run: `npm test --prefix engine`
Expected: PASS (the 4 storage tests above; vectors still passing)

- [ ] **Step 5: Commit**

```bash
git add engine/storage.js engine/test/storage.test.js
git commit -m "feat: database loading with shard merging"
```

---

### Task 4: Saving with automatic sharding (`storage.js`, part 2)

**Files:**
- Modify: `engine/storage.js`
- Test: `engine/test/storage.test.js`

- [ ] **Step 1: Add failing tests**

Append to `engine/test/storage.test.js`:

```js
test('saveDatabase writes single file when small', async () => {
  const files = await saveDatabase(dir, 'mydb', baseDb());
  assert.deepEqual(files, ['mydb.json']);
  const saved = JSON.parse(await readFile(join(dir, 'mydb.json'), 'utf8'));
  assert.equal(saved.tables.clients.rows.length, 2);
  assert.equal(saved.tables.clients.shards, undefined);
});

test('saveDatabase shards a table that exceeds the threshold', async () => {
  const db = baseDb();
  // ~30 rows of ~40 bytes each; threshold 400 bytes forces sharding
  db.tables.clients.rows = Array.from({ length: 30 }, (_, i) => [i, 'x'.repeat(20)]);
  const files = await saveDatabase(dir, 'mydb', db, { shardThreshold: 400 });
  assert.ok(files.length > 1, `expected shards, got ${files}`);
  const base = JSON.parse(await readFile(join(dir, 'mydb.json'), 'utf8'));
  assert.ok(base.tables.clients.shards.length >= 1);
  assert.equal(base.tables.clients.rows.length, 0);
  // every shard file stays under the threshold
  for (const f of base.tables.clients.shards) {
    const stat = (await readFile(join(dir, f), 'utf8')).length;
    assert.ok(stat <= 400, `${f} is ${stat} bytes`);
  }
  // round-trip: loading returns all 30 rows in order
  const loaded = await loadDatabase(dir, 'mydb');
  assert.equal(loaded.tables.clients.rows.length, 30);
  assert.deepEqual(loaded.tables.clients.rows[29][0], 29);
});

test('saveDatabase removes stale shard files when data shrinks', async () => {
  const db = baseDb();
  db.tables.clients.rows = Array.from({ length: 30 }, (_, i) => [i, 'x'.repeat(20)]);
  await saveDatabase(dir, 'mydb', db, { shardThreshold: 400 });
  const small = baseDb(); // back to 2 rows
  const files = await saveDatabase(dir, 'mydb', small, { shardThreshold: 400 });
  assert.deepEqual(files, ['mydb.json']);
  const names = await readdir(dir);
  assert.ok(!names.some(n => /mydb\.\d{3}\.json/.test(n)), `stale shards: ${names}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix engine`
Expected: FAIL — `saveDatabase is not a function`

- [ ] **Step 3: Implement saving in `engine/storage.js`**

Append to `engine/storage.js`:

```js
export async function saveDatabase(dataDir, name, db, opts = {}) {
  const threshold = opts.shardThreshold ?? DEFAULT_SHARD_THRESHOLD;
  const written = [];

  // Work on a structural copy so the caller's object is not mutated.
  const out = { githubdb: 1, tables: {} };
  for (const [tname, table] of Object.entries(db.tables)) {
    out.tables[tname] = { ...table, rows: table.rows, shards: undefined };
    delete out.tables[tname].shards;
  }

  let shardIndex = 0;
  const shardFiles = [];

  // Shard tables (largest first) until the base file fits under the threshold.
  while (Buffer.byteLength(JSON.stringify(out)) > threshold) {
    const candidates = Object.entries(out.tables)
      .filter(([, t]) => t.rows.length > 0)
      .sort((a, b) => JSON.stringify(b[1].rows).length - JSON.stringify(a[1].rows).length);
    if (candidates.length === 0) {
      throw new Error('Database row too large to fit in a single file');
    }
    const [tname, table] = candidates[0];
    const rows = table.rows;
    table.rows = [];
    table.shards = [];
    let chunk = [];
    let chunkSize = 40; // envelope overhead
    const flush = async () => {
      if (chunk.length === 0) return;
      shardIndex += 1;
      const file = `${name}.${String(shardIndex).padStart(3, '0')}.json`;
      await writeFile(join(dataDir, file), JSON.stringify({ table: tname, rows: chunk }));
      table.shards.push(file);
      shardFiles.push(file);
      written.push(file);
      chunk = [];
      chunkSize = 40;
    };
    for (const row of rows) {
      const rowSize = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (chunk.length > 0 && chunkSize + rowSize > threshold) await flush();
      if (rowSize > threshold) {
        throw new Error('Database row too large to fit in a single file');
      }
      chunk.push(row);
      chunkSize += rowSize;
    }
    await flush();
  }

  await writeFile(join(dataDir, `${name}.json`), JSON.stringify(out, null, 1));
  written.unshift(`${name}.json`);

  // Remove stale shard files from previous saves.
  const keep = new Set(shardFiles);
  const shardRe = new RegExp(`^${name}\\.\\d{3}\\.json$`);
  for (const f of await readdir(dataDir)) {
    if (shardRe.test(f) && !keep.has(f)) await unlink(join(dataDir, f));
  }
  return written;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix engine`
Expected: PASS (all storage + vectors tests)

- [ ] **Step 5: Commit**

```bash
git add engine/storage.js engine/test/storage.test.js
git commit -m "feat: database saving with automatic sharding"
```

---

### Task 5: DDL — CREATE TABLE / DROP TABLE (`sql.js`, part 1)

The engine routes statements itself: DDL is parsed with a small built-in parser (alasql's parser does not know `VECTOR(n)`); everything else goes to alasql in Task 6.

**Files:**
- Create: `engine/sql.js`
- Test: `engine/test/sql.test.js`

- [ ] **Step 1: Write failing tests**

```js
// engine/test/sql.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeQuery } from '../sql.js';
import { encodeVector } from '../vectors.js';

const emptyDb = () => ({ githubdb: 1, tables: {} });

const sampleDb = () => ({
  githubdb: 1,
  tables: {
    clients: {
      columns: [
        { name: 'id', type: 'INT' },
        { name: 'name', type: 'TEXT' },
        { name: 'email', type: 'TEXT' }
      ],
      rows: [
        [1, 'Ana', 'ana@mail.com'],
        [2, 'Luis', 'luis@mail.com']
      ]
    }
  }
});

test('CREATE TABLE adds a table with parsed columns', async () => {
  const db = emptyDb();
  const res = await executeQuery(db,
    'CREATE TABLE docs (id INT, texto TEXT, embedding VECTOR(384))');
  assert.equal(res.modified, true);
  assert.deepEqual(db.tables.docs.columns, [
    { name: 'id', type: 'INT' },
    { name: 'texto', type: 'TEXT' },
    { name: 'embedding', type: 'VECTOR(384)' }
  ]);
  assert.deepEqual(db.tables.docs.rows, []);
});

test('CREATE TABLE fails if table exists', async () => {
  const db = sampleDb();
  await assert.rejects(
    executeQuery(db, 'CREATE TABLE clients (id INT)'),
    /already exists/);
});

test('DROP TABLE removes the table', async () => {
  const db = sampleDb();
  const res = await executeQuery(db, 'DROP TABLE clients');
  assert.equal(res.modified, true);
  assert.equal(db.tables.clients, undefined);
});

test('DROP TABLE fails for unknown table', async () => {
  await assert.rejects(
    executeQuery(emptyDb(), 'DROP TABLE nope'),
    /Table 'nope' not found/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix engine`
Expected: FAIL — `Cannot find module '../sql.js'`

- [ ] **Step 3: Implement DDL routing in `engine/sql.js`**

```js
// engine/sql.js
const CREATE_RE = /^\s*CREATE\s+TABLE\s+([A-Za-z_]\w*)\s*\((.+)\)\s*;?\s*$/is;
const DROP_RE = /^\s*DROP\s+TABLE\s+([A-Za-z_]\w*)\s*;?\s*$/is;
const VALID_TYPE_RE = /^(INT|FLOAT|TEXT|BOOL|JSON|VECTOR\(\d+\))$/i;

function parseColumns(defText) {
  return defText.split(',').map(part => {
    const m = part.trim().match(/^([A-Za-z_]\w*)\s+(\w+(?:\(\d+\))?)$/);
    if (!m || !VALID_TYPE_RE.test(m[2])) {
      throw new Error(`Invalid column definition: '${part.trim()}'`);
    }
    return { name: m[1], type: m[2].toUpperCase() };
  });
}

export async function executeQuery(db, sql, params = {}, options = {}) {
  let m;
  if ((m = sql.match(CREATE_RE))) {
    const [, name, defText] = m;
    if (db.tables[name]) throw new Error(`Table '${name}' already exists`);
    db.tables[name] = { columns: parseColumns(defText), rows: [] };
    return { columns: [], rows: [], rowCount: 0, modified: true };
  }
  if ((m = sql.match(DROP_RE))) {
    const [, name] = m;
    if (!db.tables[name]) throw new Error(`Table '${name}' not found`);
    delete db.tables[name];
    return { columns: [], rows: [], rowCount: 0, modified: true };
  }
  return runDml(db, sql, params, options); // Task 6
}

async function runDml() {
  throw new Error('not implemented yet');
}
```

Note: `VECTOR(384)` contains no commas, so the simple `split(',')` is safe for all supported types.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix engine`
Expected: PASS (4 DDL tests)

- [ ] **Step 5: Commit**

```bash
git add engine/sql.js engine/test/sql.test.js
git commit -m "feat: CREATE TABLE / DROP TABLE with VECTOR(n) columns"
```

---

### Task 6: DML and SELECT via alasql (`sql.js`, part 2)

**Files:**
- Modify: `engine/sql.js`
- Test: `engine/test/sql.test.js`

- [ ] **Step 1: Add failing tests**

Append to `engine/test/sql.test.js`:

```js
test('SELECT returns columns and rows', async () => {
  const res = await executeQuery(sampleDb(), 'SELECT id, name FROM clients ORDER BY id');
  assert.equal(res.modified, false);
  assert.deepEqual(res.columns, ['id', 'name']);
  assert.deepEqual(res.rows, [[1, 'Ana'], [2, 'Luis']]);
  assert.equal(res.rowCount, 2);
});

test('SELECT with named parameters', async () => {
  const res = await executeQuery(sampleDb(),
    'SELECT name FROM clients WHERE id > :min', { min: 1 });
  assert.deepEqual(res.rows, [['Luis']]);
});

test('named parameters inside string literals are not substituted', async () => {
  const db = sampleDb();
  await executeQuery(db,
    "INSERT INTO clients VALUES (3, 'a :min b', :v)", { v: 'x@y.z' });
  assert.deepEqual(db.tables.clients.rows[2], [3, 'a :min b', 'x@y.z']);
});

test('INSERT modifies rows and reports rowCount', async () => {
  const db = sampleDb();
  const res = await executeQuery(db,
    "INSERT INTO clients VALUES (3, 'Eva', 'eva@mail.com')");
  assert.equal(res.modified, true);
  assert.equal(res.rowCount, 1);
  assert.deepEqual(db.tables.clients.rows[2], [3, 'Eva', 'eva@mail.com']);
});

test('UPDATE and DELETE work', async () => {
  const db = sampleDb();
  const upd = await executeQuery(db,
    "UPDATE clients SET email = :e WHERE id = 1", { e: 'new@mail.com' });
  assert.equal(upd.rowCount, 1);
  assert.equal(db.tables.clients.rows[0][2], 'new@mail.com');
  const del = await executeQuery(db, 'DELETE FROM clients WHERE id = 2');
  assert.equal(del.rowCount, 1);
  assert.equal(db.tables.clients.rows.length, 1);
});

test('JOIN and GROUP BY work', async () => {
  const db = sampleDb();
  db.tables.orders = {
    columns: [
      { name: 'id', type: 'INT' },
      { name: 'client_id', type: 'INT' },
      { name: 'total', type: 'FLOAT' }
    ],
    rows: [[1, 1, 10.0], [2, 1, 5.0], [3, 2, 7.5]]
  };
  const res = await executeQuery(db, `
    SELECT c.name AS name, SUM(o.total) AS total
    FROM clients c JOIN orders o ON o.client_id = c.id
    GROUP BY c.name ORDER BY total DESC`);
  assert.deepEqual(res.columns, ['name', 'total']);
  assert.deepEqual(res.rows, [['Ana', 15.0], ['Luis', 7.5]]);
});

test('unknown table produces a clear error', async () => {
  await assert.rejects(executeQuery(sampleDb(), 'SELECT * FROM nope'),
    /(nope|not found|does not exist)/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix engine`
Expected: FAIL — `not implemented yet`

- [ ] **Step 3: Implement `runDml` in `engine/sql.js`**

Replace the `runDml` stub and add imports at top of file:

```js
import alasql from 'alasql';
```

```js
const MODIFYING_RE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

// Convert :name parameters to alasql positional '?', skipping string literals.
function namedToPositional(sql, params) {
  const values = [];
  // Split into single-quoted string segments and everything else.
  const out = sql.replace(/'(?:[^']|'')*'|:(\w+)/g, (match, name) => {
    if (name === undefined) return match; // quoted string: untouched
    if (!(name in params)) throw new Error(`Missing parameter :${name}`);
    values.push(params[name]);
    return '?';
  });
  return { sql: out, values };
}

function rowToObject(columns, row) {
  const obj = {};
  columns.forEach((c, i) => { obj[c.name] = row[i] ?? null; });
  return obj;
}

function objectToRow(columns, obj) {
  return columns.map(c => obj[c.name] ?? null);
}

async function runDml(db, sql, params, options) {
  const adb = new alasql.Database();
  for (const [tname, table] of Object.entries(db.tables)) {
    adb.exec(`CREATE TABLE ${tname}`);
    adb.tables[tname].data = table.rows.map(r => rowToObject(table.columns, r));
  }

  const { sql: positionalSql, values } = namedToPositional(sql, params);
  const modifying = MODIFYING_RE.test(sql);
  const result = adb.exec(positionalSql, values);

  if (modifying) {
    for (const [tname, table] of Object.entries(db.tables)) {
      table.rows = adb.tables[tname].data.map(o => objectToRow(table.columns, o));
    }
    return { columns: [], rows: [], rowCount: typeof result === 'number' ? result : 0, modified: true };
  }

  const objects = Array.isArray(result) ? result : [];
  const columns = objects.length > 0 ? Object.keys(objects[0]) : [];
  const rows = objects.map(o => columns.map(c => o[c] ?? null));
  return { columns, rows, rowCount: rows.length, modified: false };
}
```

Note: alasql's `CREATE TABLE` without column list creates a schemaless table; data objects define the shape. Our JSON `columns` stay the source of truth for row order.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix engine`
Expected: PASS (all sql tests). If the JOIN test fails on alasql quirks (e.g. column naming of aggregates), adjust the test's SQL to use explicit `AS` aliases — already included above — and verify actual output before changing assertions.

- [ ] **Step 5: Commit**

```bash
git add engine/sql.js engine/test/sql.test.js
git commit -m "feat: DML and SELECT execution via alasql with named parameters"
```

---

### Task 7: Vector functions and validation in SQL (`sql.js`, part 3)

**Files:**
- Modify: `engine/sql.js`
- Test: `engine/test/sql.test.js`

- [ ] **Step 1: Add failing tests**

Append to `engine/test/sql.test.js`:

```js
const vectorDb = () => ({
  githubdb: 1,
  tables: {
    docs: {
      columns: [
        { name: 'id', type: 'INT' },
        { name: 'texto', type: 'TEXT' },
        { name: 'embedding', type: 'VECTOR(3)' }
      ],
      embed_from: 'texto',
      rows: [
        [1, 'norte', encodeVector([1, 0, 0])],
        [2, 'este', encodeVector([0, 1, 0])]
      ]
    }
  }
});

test('COSINE_SIM orders by similarity, vector param as array', async () => {
  const res = await executeQuery(vectorDb(), `
    SELECT id, COSINE_SIM(embedding, :v) AS score
    FROM docs ORDER BY score DESC LIMIT 1`, { v: [0.9, 0.1, 0] });
  assert.equal(res.rows[0][0], 1);
  assert.ok(res.rows[0][1] > 0.9);
});

test('vector param accepted as base64 string', async () => {
  const res = await executeQuery(vectorDb(), `
    SELECT id FROM docs WHERE COSINE_SIM(embedding, :v) > 0.99`,
    { v: encodeVector([0, 1, 0]) });
  assert.deepEqual(res.rows, [[2]]);
});

test('INSERT with array vector value stores base64 and validates dims', async () => {
  const db = vectorDb();
  await executeQuery(db, 'INSERT INTO docs VALUES (3, :t, :v)',
    { t: 'oeste', v: [-1, 0, 0] });
  const cell = db.tables.docs.rows[2][2];
  assert.equal(typeof cell, 'string');
  assert.deepEqual(Array.from((await import('../vectors.js')).decodeVector(cell, 3)), [-1, 0, 0]);
});

test('INSERT with wrong vector dimensions fails, data unchanged', async () => {
  const db = vectorDb();
  await assert.rejects(
    executeQuery(db, 'INSERT INTO docs VALUES (3, :t, :v)', { t: 'x', v: [1, 2] }),
    /expected 3, got 2/);
});

test('auto-embed fills NULL vector cells from embed_from column', async () => {
  const db = vectorDb();
  const fakeEmbed = async (text) => text === 'sur' ? [0, 0, 1] : [9, 9, 9];
  await executeQuery(db, "INSERT INTO docs (id, texto) VALUES (4, 'sur')",
    {}, { embedPassage: fakeEmbed });
  const row = db.tables.docs.rows.find(r => r[0] === 4);
  assert.deepEqual(Array.from((await import('../vectors.js')).decodeVector(row[2], 3)), [0, 0, 1]);
});

test('EMBED() in SQL uses query embedding function', async () => {
  const fakeQueryEmbed = async (text) => text === 'brújula' ? [1, 0, 0] : [0, 0, 0];
  const res = await executeQuery(vectorDb(), `
    SELECT id, COSINE_SIM(embedding, EMBED('brújula')) AS score
    FROM docs ORDER BY score DESC LIMIT 1`,
    {}, { embedQuery: fakeQueryEmbed });
  assert.equal(res.rows[0][0], 1);
});

test('non-null client vector is never overwritten by auto-embed', async () => {
  const db = vectorDb();
  const fakeEmbed = async () => [9, 9, 9];
  await executeQuery(db, 'INSERT INTO docs VALUES (5, :t, :v)',
    { t: 'propio', v: [0.5, 0.5, 0] }, { embedPassage: fakeEmbed });
  const row = db.tables.docs.rows.find(r => r[0] === 5);
  const vec = Array.from((await import('../vectors.js')).decodeVector(row[2], 3));
  assert.ok(Math.abs(vec[0] - 0.5) < 1e-6);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix engine`
Expected: FAIL — `COSINE_SIM is not defined` (or similar alasql error)

- [ ] **Step 3: Implement vector support in `engine/sql.js`**

Add import and register alasql functions once at module level:

```js
import { encodeVector, toVector, cosineSim, dotProduct, euclidean } from './vectors.js';

alasql.fn.COSINE_SIM = (a, b) => cosineSim(toVector(a), toVector(b));
alasql.fn.DOT_PRODUCT = (a, b) => dotProduct(toVector(a), toVector(b));
alasql.fn.EUCLIDEAN = (a, b) => euclidean(toVector(a), toVector(b));
```

Add helpers and wire them into `runDml`:

```js
function vectorColumns(table) {
  return table.columns
    .map((c, i) => ({ ...c, index: i, dims: /^VECTOR\((\d+)\)$/.exec(c.type)?.[1] }))
    .filter(c => c.dims !== undefined)
    .map(c => ({ ...c, dims: Number(c.dims) }));
}

// EMBED('literal') is resolved before execution because embedding is async
// and alasql functions are synchronous. Only string literals are supported.
async function resolveEmbedCalls(sql, params, embedQuery) {
  const re = /EMBED\(\s*'((?:[^']|'')*)'\s*\)/gi;
  let i = 0;
  const jobs = [];
  const out = sql.replace(re, (_, literal) => {
    const name = `__embed_${i++}`;
    jobs.push(async () => {
      if (!embedQuery) throw new Error('EMBED() is not available: no embedding function configured');
      params[name] = encodeVector(await embedQuery(literal.replace(/''/g, "'")));
    });
    return `:${name}`;
  });
  for (const job of jobs) await job();
  return out;
}

// Normalize vector cells after a modifying statement:
// arrays -> base64, strings -> dimension-validated, NULL -> auto-embed.
async function normalizeVectors(db, embedPassage) {
  for (const table of Object.values(db.tables)) {
    const vcols = vectorColumns(table);
    if (vcols.length === 0) continue;
    const embedFromIdx = table.embed_from
      ? table.columns.findIndex(c => c.name === table.embed_from) : -1;
    for (const row of table.rows) {
      for (const col of vcols) {
        const v = row[col.index];
        if (v === null || v === undefined) {
          if (embedFromIdx >= 0 && embedPassage && row[embedFromIdx] != null) {
            row[col.index] = encodeVector(await embedPassage(String(row[embedFromIdx])));
          }
        } else if (typeof v === 'string') {
          toVector(v, col.dims); // validate dims
        } else {
          row[col.index] = encodeVector(toVector(v, col.dims));
        }
      }
    }
  }
}
```

In `runDml`, change the body to resolve EMBED before parameter conversion and normalize after write-back. The full updated `runDml`:

```js
async function runDml(db, sql, params, options) {
  const adb = new alasql.Database();
  for (const [tname, table] of Object.entries(db.tables)) {
    adb.exec(`CREATE TABLE ${tname}`);
    adb.tables[tname].data = table.rows.map(r => rowToObject(table.columns, r));
  }

  const effectiveParams = { ...params };
  const sqlWithEmbeds = await resolveEmbedCalls(sql, effectiveParams, options.embedQuery);
  const { sql: positionalSql, values } = namedToPositional(sqlWithEmbeds, effectiveParams);
  const modifying = MODIFYING_RE.test(sql);
  const result = adb.exec(positionalSql, values);

  if (modifying) {
    const snapshot = JSON.stringify(Object.fromEntries(
      Object.entries(db.tables).map(([n, t]) => [n, t.rows])));
    for (const [tname, table] of Object.entries(db.tables)) {
      table.rows = adb.tables[tname].data.map(o => objectToRow(table.columns, o));
    }
    try {
      await normalizeVectors(db, options.embedPassage);
    } catch (e) {
      // restore rows so a validation error leaves data untouched
      const prev = JSON.parse(snapshot);
      for (const [tname, rows] of Object.entries(prev)) db.tables[tname].rows = rows;
      throw e;
    }
    return { columns: [], rows: [], rowCount: typeof result === 'number' ? result : 0, modified: true };
  }

  const objects = Array.isArray(result) ? result : [];
  const columns = objects.length > 0 ? Object.keys(objects[0]) : [];
  const rows = objects.map(o => columns.map(c => o[c] ?? null));
  return { columns, rows, rowCount: rows.length, modified: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix engine`
Expected: PASS (all tests so far)

- [ ] **Step 5: Commit**

```bash
git add engine/sql.js engine/test/sql.test.js
git commit -m "feat: vector SQL functions, dimension validation and auto-embed"
```

---

### Task 8: Embedding model wrapper (`embed.js`)

No unit tests for the real model (120 MB download); correctness is covered by mocked tests in Task 7 and verified end-to-end in Task 12.

**Files:**
- Create: `engine/embed.js`

- [ ] **Step 1: Implement `engine/embed.js`**

```js
// engine/embed.js
// Local embeddings with multilingual-e5-small (384 dims) via transformers.js.
// e5 models expect 'query: ' / 'passage: ' prefixes for asymmetric retrieval.

let pipePromise;

async function getPipe() {
  pipePromise ??= (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    return pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
  })();
  return pipePromise;
}

async function embedWithPrefix(prefix, text) {
  const pipe = await getPipe();
  const out = await pipe(prefix + text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

export const embedPassage = (text) => embedWithPrefix('passage: ', text);
export const embedQuery = (text) => embedWithPrefix('query: ', text);
```

- [ ] **Step 2: Smoke-test locally (one-off, not part of the suite)**

Run:
```bash
node --input-type=module -e "import('./engine/embed.js').then(async m => { const v = await m.embedQuery('hola'); console.log(v.length, v[0]); })"
```
Expected: prints `384` and a small float. First run downloads the model (~120 MB); allow a few minutes.

- [ ] **Step 3: Commit**

```bash
git add engine/embed.js
git commit -m "feat: local embedding wrapper (multilingual-e5-small)"
```

---

### Task 9: Orchestrator (`run-query.js`) + results I/O

**Files:**
- Modify: `engine/storage.js` (add `writeResult`, `cleanupResults`)
- Create: `engine/run-query.js`
- Test: `engine/test/run-query.test.js`

- [ ] **Step 1: Write failing tests**

```js
// engine/test/run-query.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQuery } from '../run-query.js';
import { cleanupResults } from '../storage.js';

let root, dataDir, resultsDir;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'githubdb-run-'));
  dataDir = join(root, 'data');
  resultsDir = join(root, 'results');
  await mkdir(dataDir);
  await mkdir(resultsDir);
  await writeFile(join(dataDir, 'example.json'), JSON.stringify({
    githubdb: 1,
    tables: {
      clients: {
        columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }],
        rows: [[1, 'Ana']]
      }
    }
  }));
});

const opts = () => ({ dataDir, resultsDir });

test('SELECT writes ok result file and does not modify data', async () => {
  await runQuery({ id: 'q1', db: 'example', sql: 'SELECT * FROM clients' }, opts());
  const res = JSON.parse(await readFile(join(resultsDir, 'q1.json'), 'utf8'));
  assert.equal(res.ok, true);
  assert.equal(res.id, 'q1');
  assert.deepEqual(res.rows, [[1, 'Ana']]);
  assert.equal(typeof res.ts, 'string');
  assert.equal(typeof res.elapsedMs, 'number');
});

test('INSERT persists data changes', async () => {
  await runQuery({ id: 'q2', db: 'example',
    sql: 'INSERT INTO clients VALUES (:id, :n)', params: { id: 2, n: 'Luis' } }, opts());
  const db = JSON.parse(await readFile(join(dataDir, 'example.json'), 'utf8'));
  assert.equal(db.tables.clients.rows.length, 2);
  const res = JSON.parse(await readFile(join(resultsDir, 'q2.json'), 'utf8'));
  assert.equal(res.ok, true);
  assert.equal(res.rowCount, 1);
});

test('errors produce ok:false result file, data untouched', async () => {
  await runQuery({ id: 'q3', db: 'nope', sql: 'SELECT 1' }, opts());
  const res = JSON.parse(await readFile(join(resultsDir, 'q3.json'), 'utf8'));
  assert.equal(res.ok, false);
  assert.match(res.error, /Database 'nope' not found/);
});

test('invalid SQL produces ok:false result file', async () => {
  await runQuery({ id: 'q4', db: 'example', sql: 'SELEKT broken' }, opts());
  const res = JSON.parse(await readFile(join(resultsDir, 'q4.json'), 'utf8'));
  assert.equal(res.ok, false);
  assert.equal(typeof res.error, 'string');
});

test('missing id is a no-op (no result file, no throw)', async () => {
  await runQuery({ db: 'example', sql: 'SELECT 1' }, opts());
  assert.deepEqual(await readdir(resultsDir), []);
});

test('cleanupResults removes results older than maxAge', async () => {
  const old = new Date(Date.now() - 2 * 3600_000).toISOString();
  const fresh = new Date().toISOString();
  await writeFile(join(resultsDir, 'old.json'), JSON.stringify({ ok: true, ts: old }));
  await writeFile(join(resultsDir, 'fresh.json'), JSON.stringify({ ok: true, ts: fresh }));
  await writeFile(join(resultsDir, 'garbage.json'), 'not json');
  await cleanupResults(resultsDir, 3600_000);
  const names = (await readdir(resultsDir)).sort();
  assert.deepEqual(names, ['fresh.json', 'garbage.json']);
});
```

(`garbage.json` stays: unparseable files are left alone rather than crashing the run.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --prefix engine`
Expected: FAIL — `Cannot find module '../run-query.js'`

- [ ] **Step 3: Add results I/O to `engine/storage.js`**

Append:

```js
export async function writeResult(resultsDir, id, result) {
  await writeFile(join(resultsDir, `${id}.json`),
    JSON.stringify({ ...result, ts: new Date().toISOString() }, null, 1));
}

export async function cleanupResults(resultsDir, maxAgeMs) {
  const now = Date.now();
  for (const f of await readdir(resultsDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const { ts } = JSON.parse(await readFile(join(resultsDir, f), 'utf8'));
      if (ts && now - Date.parse(ts) > maxAgeMs) await unlink(join(resultsDir, f));
    } catch {
      // unreadable result file: leave it, never crash the run
    }
  }
}
```

- [ ] **Step 4: Implement `engine/run-query.js`**

```js
// engine/run-query.js
// Entry point for the GitHub Action. Reads the dispatch payload from
// GITHUBDB_PAYLOAD, executes the query and writes results/<id>.json.
import { fileURLToPath } from 'node:url';
import { loadDatabase, saveDatabase, writeResult, cleanupResults } from './storage.js';
import { executeQuery } from './sql.js';

const RESULT_MAX_AGE_MS = 3600_000; // 1 hour

export async function runQuery(payload, { dataDir, resultsDir, embedFns } = {}) {
  const { id, db: dbName, sql, params } = payload ?? {};
  if (!id) {
    console.error('githubDB: payload has no id; nowhere to write the result. Skipping.');
    return;
  }
  const started = Date.now();
  try {
    if (!dbName || !sql) throw new Error("Payload must include 'db' and 'sql'");
    const db = await loadDatabase(dataDir, dbName);
    const fns = embedFns ?? await import('./embed.js');
    const res = await executeQuery(db, sql, params ?? {}, {
      embedPassage: fns.embedPassage,
      embedQuery: fns.embedQuery
    });
    if (res.modified) await saveDatabase(dataDir, dbName, db);
    await writeResult(resultsDir, id, {
      ok: true, id,
      rowCount: res.rowCount, columns: res.columns, rows: res.rows,
      elapsedMs: Date.now() - started
    });
  } catch (e) {
    await writeResult(resultsDir, id, { ok: false, id, error: String(e.message ?? e) });
  }
  await cleanupResults(resultsDir, RESULT_MAX_AGE_MS);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const payload = JSON.parse(process.env.GITHUBDB_PAYLOAD ?? '{}');
  await runQuery(payload, { dataDir: 'data', resultsDir: 'results' });
}
```

One subtlety: `CREATE TABLE` on a missing database must create it. Adjust `runQuery` — replace the `loadDatabase` line with:

```js
    let db;
    try {
      db = await loadDatabase(dataDir, dbName);
    } catch (e) {
      if (/not found/.test(String(e)) && /^\s*CREATE\s+TABLE/i.test(sql)) {
        db = { githubdb: 1, tables: {} };
      } else {
        throw e;
      }
    }
```

Add a matching test to `engine/test/run-query.test.js`:

```js
test('CREATE TABLE on a new database creates the file', async () => {
  await runQuery({ id: 'q5', db: 'newdb',
    sql: 'CREATE TABLE t (id INT)' }, opts());
  const db = JSON.parse(await readFile(join(dataDir, 'newdb.json'), 'utf8'));
  assert.deepEqual(db.tables.t.columns, [{ name: 'id', type: 'INT' }]);
  const res = JSON.parse(await readFile(join(resultsDir, 'q5.json'), 'utf8'));
  assert.equal(res.ok, true);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test --prefix engine`
Expected: PASS (full suite)

- [ ] **Step 6: Commit**

```bash
git add engine/run-query.js engine/storage.js engine/test/run-query.test.js
git commit -m "feat: query orchestrator with result files and cleanup"
```

---

### Task 10: Workflow (`query.yml`)

**Files:**
- Create: `.github/workflows/query.yml`
- Create: `results/.gitkeep`

- [ ] **Step 1: Create `results/.gitkeep`** (empty file, keeps the directory in Git)

- [ ] **Step 2: Create `.github/workflows/query.yml`**

```yaml
name: githubDB query

on:
  repository_dispatch:
    types: [query]

# Queries on the same database run serially; different databases in parallel.
concurrency:
  group: githubdb-${{ github.event.client_payload.db }}

permissions:
  contents: write

jobs:
  query:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: engine/package-lock.json

      - name: Cache embedding model
        uses: actions/cache@v4
        with:
          path: ~/.cache/huggingface
          key: githubdb-model-multilingual-e5-small

      - name: Install engine
        run: npm ci --prefix engine

      - name: Execute query and push (retry on race)
        env:
          GITHUBDB_PAYLOAD: ${{ toJSON(github.event.client_payload) }}
          HF_HOME: ~/.cache/huggingface
        run: |
          git config user.name "githubDB"
          git config user.email "githubdb@users.noreply.github.com"
          for attempt in 1 2 3; do
            node engine/run-query.js
            git add data results
            if git diff --cached --quiet; then
              echo "No changes to commit"; exit 0
            fi
            git commit -m "githubDB query ${{ github.event.client_payload.id }}"
            if git push; then
              exit 0
            fi
            echo "Push race detected (attempt $attempt); re-executing"
            git reset --hard HEAD~1
            git pull --rebase origin main
          done
          echo "Failed after 3 attempts" >&2
          exit 1
```

Notes:
- The engine re-runs on each retry against freshly pulled data — this is the spec's "pull + re-execute ×3".
- `git add data results` only: the workflow never commits engine or docs changes.

- [ ] **Step 3: Validate YAML locally**

Run: `node -e "console.log('ok')" && npx --yes yaml-lint .github/workflows/query.yml || true`
Simpler check if yaml-lint unavailable: open the file and verify indentation; the real validation is the E2E task.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/query.yml results/.gitkeep
git commit -m "feat: repository_dispatch query workflow with concurrency and push retry"
```

---

### Task 11: Sample database, client examples, license

**Files:**
- Create: `data/example.json`
- Create: `clients/curl.sh`, `clients/python.py`, `clients/javascript.js`
- Create: `LICENSE`

- [ ] **Step 1: Create `data/example.json`**

```json
{
 "githubdb": 1,
 "tables": {
  "clients": {
   "columns": [
    { "name": "id", "type": "INT" },
    { "name": "name", "type": "TEXT" },
    { "name": "email", "type": "TEXT" }
   ],
   "rows": [
    [1, "Ana", "ana@mail.com"],
    [2, "Luis", "luis@mail.com"]
   ]
  },
  "docs": {
   "columns": [
    { "name": "id", "type": "INT" },
    { "name": "texto", "type": "TEXT" },
    { "name": "embedding", "type": "VECTOR(384)" }
   ],
   "embed_from": "texto",
   "rows": []
  }
 }
}
```

- [ ] **Step 2: Create `clients/curl.sh`**

```bash
#!/usr/bin/env bash
# githubDB client example: send a query and poll for the result.
# Usage: GITHUB_TOKEN=... OWNER=you ./curl.sh "SELECT * FROM clients" [db]
set -euo pipefail

SQL="${1:?usage: curl.sh \"SQL\" [db]}"
DB="${2:-example}"
OWNER="${OWNER:?set OWNER to your GitHub user/org}"
REPO="${REPO:-githubdb}"
BRANCH="${BRANCH:-main}"
ID="$(uuidgen | tr 'A-Z' 'a-z')"

curl -fsS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$OWNER/$REPO/dispatches" \
  -d "$(printf '{"event_type":"query","client_payload":{"id":"%s","db":"%s","sql":%s}}' \
        "$ID" "$DB" "$(printf '%s' "$SQL" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"

echo "query id: $ID — polling..."
URL="https://raw.githubusercontent.com/$OWNER/$REPO/$BRANCH/results/$ID.json"
for i in $(seq 1 40); do
  sleep 3
  if RESULT="$(curl -fsS "$URL" 2>/dev/null)"; then
    echo "$RESULT"
    exit 0
  fi
done
echo "timeout after 120s" >&2
exit 1
```

- [ ] **Step 3: Create `clients/python.py`**

```python
#!/usr/bin/env python3
"""githubDB client example: send a query and poll for the result.

Usage:
    GITHUB_TOKEN=... python3 python.py OWNER "SELECT * FROM clients" [db]
"""
import json
import os
import sys
import time
import urllib.request
import uuid

def query(owner, sql, db="example", repo="githubdb", branch="main",
          params=None, timeout=120, interval=3):
    qid = str(uuid.uuid4())
    payload = {"event_type": "query",
               "client_payload": {"id": qid, "db": db, "sql": sql,
                                   "params": params or {}}}
    req = urllib.request.Request(
        f"https://api.github.com/repos/{owner}/{repo}/dispatches",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
                 "Accept": "application/vnd.github+json"},
        method="POST")
    urllib.request.urlopen(req)

    url = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/results/{qid}.json"
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(interval)
        try:
            with urllib.request.urlopen(url) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
    raise TimeoutError(f"no result after {timeout}s (id={qid})")

if __name__ == "__main__":
    owner, sql = sys.argv[1], sys.argv[2]
    db = sys.argv[3] if len(sys.argv) > 3 else "example"
    print(json.dumps(query(owner, sql, db), indent=2, ensure_ascii=False))
```

- [ ] **Step 4: Create `clients/javascript.js`**

```js
#!/usr/bin/env node
// githubDB client example: send a query and poll for the result.
// Usage: GITHUB_TOKEN=... node javascript.js OWNER "SELECT * FROM clients" [db]
import { randomUUID } from 'node:crypto';

export async function query(owner, sql, {
  db = 'example', repo = 'githubdb', branch = 'main',
  params = {}, timeoutMs = 120_000, intervalMs = 3_000
} = {}) {
  const id = randomUUID();
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json'
    },
    body: JSON.stringify({
      event_type: 'query',
      client_payload: { id, db, sql, params }
    })
  });
  if (!res.ok) throw new Error(`dispatch failed: ${res.status} ${await res.text()}`);

  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/results/${id}.json`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    const poll = await fetch(url);
    if (poll.ok) return poll.json();
  }
  throw new Error(`no result after ${timeoutMs / 1000}s (id=${id})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [owner, sql, db] = process.argv.slice(2);
  console.log(JSON.stringify(await query(owner, sql, { db: db ?? 'example' }), null, 2));
}
```

- [ ] **Step 5: Create `LICENSE`** — standard MIT text, copyright line:

```
MIT License

Copyright (c) 2026 FiveTech Software

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 6: Commit**

```bash
git add data/example.json clients/ LICENSE
git commit -m "feat: sample database, client examples and MIT license"
```

---

### Task 12: End-to-end verification and release

**Files:**
- Modify: `README.md` (status line)

- [ ] **Step 1: Run the full test suite one last time**

Run: `npm test --prefix engine`
Expected: PASS, zero failures.

- [ ] **Step 2: Push everything**

```bash
git push
```

- [ ] **Step 3: E2E — dispatch a real query against the repo**

```bash
ID=$(uuidgen | tr 'A-Z' 'a-z')
gh api repos/FiveTechSoft/githubdb/dispatches \
  -f event_type=query \
  -F "client_payload[id]=$ID" \
  -F "client_payload[db]=example" \
  -F "client_payload[sql]=SELECT * FROM clients"
echo $ID
```

Watch the run: `gh run watch --repo FiveTechSoft/githubdb` (or `gh run list --repo FiveTechSoft/githubdb`).

- [ ] **Step 4: Verify the result file**

```bash
curl -s "https://raw.githubusercontent.com/FiveTechSoft/githubdb/main/results/$ID.json"
```
Expected: `{"ok": true, ..., "rows": [[1,"Ana"],[2,"Luis"]], ...}`

- [ ] **Step 5: E2E — write + auto-embed**

```bash
ID2=$(uuidgen | tr 'A-Z' 'a-z')
gh api repos/FiveTechSoft/githubdb/dispatches \
  -f event_type=query \
  -F "client_payload[id]=$ID2" \
  -F "client_payload[db]=example" \
  -F "client_payload[sql]=INSERT INTO docs (id, texto) VALUES (1, 'Cómo configurar el servidor SMTP')"
```
After the run, verify `data/example.json` in the repo: the `docs` row exists and `embedding` is a base64 string. Then a semantic search:

```bash
ID3=$(uuidgen | tr 'A-Z' 'a-z')
gh api repos/FiveTechSoft/githubdb/dispatches \
  -f event_type=query \
  -F "client_payload[id]=$ID3" \
  -F "client_payload[db]=example" \
  -F "client_payload[sql]=SELECT id, texto, COSINE_SIM(embedding, EMBED('correo no funciona')) AS score FROM docs ORDER BY score DESC LIMIT 3"
```
Expected: `ok: true` with the SMTP row scoring highest.

- [ ] **Step 6: Update README status and push**

In `README.md`, replace the status blockquote with:

```markdown
> **Status: working preview.** The engine is functional — fork and try it. APIs may still change before 1.0.
```

```bash
git add README.md
git commit -m "docs: mark engine as working preview"
git push
```

---

## Self-review notes

- **Spec coverage:** loading/sharding (Tasks 3–4), DDL (5), DML/SELECT/params (6), vector functions + validation + auto-embed + EMBED (7), model (8), orchestrator/result format/cleanup/error table (9), workflow/concurrency/retry/cache (10), sample data + clients + license (11), E2E (12). Result `ts` field added in Task 9 (needed by cleanup since Git does not preserve mtimes) — spec's result format gains one field; harmless addition.
- **Push-race re-execution** is implemented in the workflow loop (Task 10), not in Node — matches the spec's "pull + re-execute up to 3 times".
- **Known risk:** alasql behavior on JOIN aliasing and `exec` return values for DML can differ by version — Task 6 Step 4 includes explicit instructions to verify actual output before adjusting assertions.
