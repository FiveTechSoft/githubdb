// engine/test/stress/stress.test.js
// Run with: npm run test:stress --prefix engine
// NOT included in the default `npm test` suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeVector, decodeVector, cosineSim } from '../../vectors.js';
import { loadDatabase, saveDatabase, writeResult, cleanupResults } from '../../storage.js';
import { executeQuery } from '../../sql.js';
import { runQuery } from '../../run-query.js';

// ---------------------------------------------------------------------------
// Tiny deterministic PRNG: mulberry32
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// Generate a random unit vector of `dims` dimensions using the provided rng.
function randomUnitVector(dims, rng) {
  const v = new Float32Array(dims);
  let sum = 0;
  for (let i = 0; i < dims; i++) { v[i] = rng() * 2 - 1; sum += v[i] * v[i]; }
  const norm = Math.sqrt(sum);
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

// Make a tmp dir (with optional sub-dirs) and return absolute path(s).
async function makeTmpDir() {
  return mkdtemp(join(tmpdir(), 'githubdb-stress-'));
}

// ---------------------------------------------------------------------------
// VECTORS AT SCALE
// ---------------------------------------------------------------------------

test('vectors: encode+decode round-trip 10,000 × 384 dims', async () => {
  const N = 10_000;
  const DIMS = 384;
  const rng = mulberry32(0xdeadbeef);
  const t0 = Date.now();

  // Encode all
  const encoded = [];
  for (let i = 0; i < N; i++) {
    encoded.push(encodeVector(randomUnitVector(DIMS, rng)));
  }

  // Decode a sample (every 100th vector) and verify against freshly re-generated values
  const rng2 = mulberry32(0xdeadbeef); // same seed
  for (let i = 0; i < N; i++) {
    const original = randomUnitVector(DIMS, rng2);
    if (i % 100 === 0) {
      const decoded = decodeVector(encoded[i], DIMS);
      assert.equal(decoded.length, DIMS, `row ${i}: wrong dim count`);
      // Float32 round-trip: values must be exactly equal
      for (let d = 0; d < DIMS; d++) {
        assert.equal(decoded[d], original[d], `row ${i} dim ${d} mismatch`);
      }
    }
  }

  const elapsed = Date.now() - t0;
  console.log(`[stress] vectors encode+decode 10k×384: ${elapsed}ms`);
  assert.ok(elapsed < 30_000, `encode+decode took ${elapsed}ms, expected < 30s`);
});

test('vectors: brute-force cosine search 100,000 × 384 dims top-10', async () => {
  const N = 100_000;
  const DIMS = 384;
  const rng = mulberry32(0xcafebabe);

  // Generate vectors; plant a near-duplicate of a known query at index PLANT_IDX
  const PLANT_IDX = 73_417;
  const query = randomUnitVector(DIMS, rng); // consume first vector slot as query basis

  const vectors = new Array(N);
  for (let i = 0; i < N; i++) {
    if (i === PLANT_IDX) {
      // Near-duplicate: perturb each component very slightly (0.001 scale)
      const perturbed = Float32Array.from(query);
      let norm = 0;
      for (let d = 0; d < DIMS; d++) {
        perturbed[d] += (rng() - 0.5) * 0.001;
        norm += perturbed[d] * perturbed[d];
      }
      norm = Math.sqrt(norm);
      for (let d = 0; d < DIMS; d++) perturbed[d] /= norm;
      vectors[i] = perturbed;
    } else {
      vectors[i] = randomUnitVector(DIMS, rng);
    }
  }

  const t0 = Date.now();

  // Score all
  const scores = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    scores[i] = cosineSim(query, vectors[i]);
  }

  // Top-10 via partial sort
  const indices = Array.from({ length: N }, (_, i) => i);
  indices.sort((a, b) => scores[b] - scores[a]);
  const top10 = indices.slice(0, 10);

  const elapsed = Date.now() - t0;
  console.log(`[stress] vectors brute-force cosine 100k×384 top-10: ${elapsed}ms`);

  assert.ok(elapsed < 10_000, `brute-force search took ${elapsed}ms, expected < 10s`);
  assert.equal(top10[0], PLANT_IDX, `expected planted near-duplicate (idx ${PLANT_IDX}) as top-1, got idx ${top10[0]} with score ${scores[top10[0]]}`);
  assert.ok(scores[PLANT_IDX] > 0.999, `planted vector cosine sim ${scores[PLANT_IDX]} should be > 0.999`);
});

// ---------------------------------------------------------------------------
// STORAGE AT SCALE
// ---------------------------------------------------------------------------

test('storage: 100,000-row table sharding save+load round-trip', async () => {
  const dir = await makeTmpDir();
  const N = 100_000;
  const SHARD_THRESHOLD = 1024 * 1024; // 1 MB
  const rng = mulberry32(0x12345678);

  // Build rows ~100 bytes each: [id, paddedName]
  const rows = Array.from({ length: N }, (_, i) => {
    const pad = 'x'.repeat(80);
    return [i, `row_${String(i).padStart(6, '0')}_${pad}`];
  });

  const db = {
    githubdb: 1,
    tables: {
      bigtable: {
        columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }],
        rows
      }
    }
  };

  const t0 = Date.now();
  const files = await saveDatabase(dir, 'bigdb', db, { shardThreshold: SHARD_THRESHOLD });
  const saveDur = Date.now() - t0;
  console.log(`[stress] storage save 100k rows (${files.length} files): ${saveDur}ms`);

  assert.ok(files.length > 1, `expected shards, got ${files.length} file(s)`);

  // Verify each shard file ≤ threshold (allow +5% overhead for header/envelope)
  const TOLERANCE = SHARD_THRESHOLD * 1.05;
  for (const f of files) {
    const size = Buffer.byteLength(await readFile(join(dir, f), 'utf8'));
    if (f !== `bigdb.json`) { // base file may be small (just references)
      assert.ok(size <= TOLERANCE,
        `shard ${f} is ${size} bytes, exceeds ${TOLERANCE}`);
    }
  }

  const t1 = Date.now();
  const loaded = await loadDatabase(dir, 'bigdb');
  const loadDur = Date.now() - t1;
  console.log(`[stress] storage load 100k rows: ${loadDur}ms`);

  assert.equal(loaded.tables.bigtable.rows.length, N, 'row count after round-trip');
  // Check first and last
  assert.deepEqual(loaded.tables.bigtable.rows[0], rows[0]);
  assert.deepEqual(loaded.tables.bigtable.rows[N - 1], rows[N - 1]);
  // Spot-check ~10 random rows
  for (let i = 0; i < 10; i++) {
    const idx = Math.floor(rng() * N);
    assert.deepEqual(loaded.tables.bigtable.rows[idx], rows[idx],
      `mismatch at sample row ${idx}`);
  }
});

test('storage: re-save after deleting 90% rows removes stale shards', async () => {
  const dir = await makeTmpDir();
  const N = 100_000;
  const SHARD_THRESHOLD = 1024 * 1024;

  const rows = Array.from({ length: N }, (_, i) => [i, 'x'.repeat(80)]);
  const db = {
    githubdb: 1,
    tables: {
      bigtable: {
        columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }],
        rows
      }
    }
  };

  const initialFiles = await saveDatabase(dir, 'bigdb', db, { shardThreshold: SHARD_THRESHOLD });
  assert.ok(initialFiles.length > 1, 'initial save should have shards');

  // Delete 90% of rows
  db.tables.bigtable.rows = rows.filter((_, i) => i % 10 === 0); // keep every 10th
  assert.equal(db.tables.bigtable.rows.length, N / 10);

  const t0 = Date.now();
  const newFiles = await saveDatabase(dir, 'bigdb', db, { shardThreshold: SHARD_THRESHOLD });
  const elapsed = Date.now() - t0;
  console.log(`[stress] storage re-save after 90% delete (${newFiles.length} files): ${elapsed}ms`);

  // Check no stale shards
  const allFiles = await readdir(dir);
  const shardRe = /^bigdb\.\d{3}\.json$/;
  const remainingShards = allFiles.filter(f => shardRe.test(f));
  const expectedShards = newFiles.filter(f => shardRe.test(f));
  assert.equal(remainingShards.length, expectedShards.length,
    `stale shards remain: ${remainingShards.filter(f => !expectedShards.includes(f))}`);

  // Round-trip
  const loaded = await loadDatabase(dir, 'bigdb');
  assert.equal(loaded.tables.bigtable.rows.length, N / 10);
  assert.deepEqual(loaded.tables.bigtable.rows[0], rows[0]);
  assert.deepEqual(loaded.tables.bigtable.rows[N / 10 - 1], rows[N - 10]);
});

test('storage: 50 tables × 2,000 rows save+load integrity', async () => {
  const dir = await makeTmpDir();
  const NUM_TABLES = 50;
  const ROWS_PER_TABLE = 2_000;
  const rng = mulberry32(0xabcdef01);

  const db = { githubdb: 1, tables: {} };
  for (let t = 0; t < NUM_TABLES; t++) {
    const tname = `table_${String(t).padStart(2, '0')}`;
    db.tables[tname] = {
      columns: [{ name: 'id', type: 'INT' }, { name: 'val', type: 'TEXT' }],
      rows: Array.from({ length: ROWS_PER_TABLE }, (_, i) => [i, `v${t}_${i}`])
    };
  }

  const t0 = Date.now();
  await saveDatabase(dir, 'multidb', db);
  const saveDur = Date.now() - t0;

  const t1 = Date.now();
  const loaded = await loadDatabase(dir, 'multidb');
  const loadDur = Date.now() - t1;
  console.log(`[stress] storage 50 tables×2k rows save+load: ${saveDur}ms + ${loadDur}ms`);

  assert.equal(Object.keys(loaded.tables).length, NUM_TABLES);

  // Sample integrity: check 5 random table/row combos
  for (let i = 0; i < 5; i++) {
    const tIdx = Math.floor(rng() * NUM_TABLES);
    const rIdx = Math.floor(rng() * ROWS_PER_TABLE);
    const tname = `table_${String(tIdx).padStart(2, '0')}`;
    assert.deepEqual(loaded.tables[tname].rows[rIdx], [rIdx, `v${tIdx}_${rIdx}`],
      `integrity mismatch table ${tname} row ${rIdx}`);
  }
});

// ---------------------------------------------------------------------------
// SQL AT SCALE
// ---------------------------------------------------------------------------

test('sql: SELECT WHERE + ORDER BY LIMIT 10 over 100,000 rows', async () => {
  const N = 100_000;
  const rng = mulberry32(0x11223344);

  const rows = Array.from({ length: N }, (_, i) => [i, Math.floor(rng() * 1000), `name_${i}`]);
  const db = {
    githubdb: 1,
    tables: {
      items: {
        columns: [
          { name: 'id', type: 'INT' },
          { name: 'score', type: 'INT' },
          { name: 'name', type: 'TEXT' }
        ],
        rows
      }
    }
  };

  // Compute expected top-10 by score DESC where score > 900, JS-side
  const expectedTop10 = rows
    .filter(r => r[1] > 900)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 10)
    .map(r => [r[0], r[1], r[2]]);

  const t0 = Date.now();
  const res = await executeQuery(db,
    'SELECT id, score, name FROM items WHERE score > 900 ORDER BY score DESC LIMIT 10');
  const elapsed = Date.now() - t0;
  console.log(`[stress] sql SELECT WHERE+ORDER BY+LIMIT 100k rows: ${elapsed}ms`);

  assert.ok(elapsed < 30_000, `query took ${elapsed}ms`);
  assert.equal(res.rowCount, 10);
  // Top result should have highest score among score > 900
  assert.equal(res.rows[0][1], expectedTop10[0][1], 'top-1 score mismatch');
  assert.ok(res.rows[0][1] > 900, 'top result score must be > 900');
  // Scores should be descending
  for (let i = 0; i < res.rows.length - 1; i++) {
    assert.ok(res.rows[i][1] >= res.rows[i + 1][1], 'order not descending');
  }
});

test('sql: JOIN 10k×10k clients×orders GROUP BY, known aggregate', async () => {
  const N_CLIENTS = 10_000;
  const N_ORDERS = 10_000;
  const rng = mulberry32(0x55667788);

  // Build clients
  const clientRows = Array.from({ length: N_CLIENTS }, (_, i) => [i, `client_${i}`]);

  // Build orders: assign each to a random client, random amount 1–100
  const orderRows = Array.from({ length: N_ORDERS }, (_, i) => {
    const clientId = Math.floor(rng() * N_CLIENTS);
    const amount = Math.round(rng() * 99) + 1;
    return [i, clientId, amount];
  });

  // Compute expected total for client 0 in JS
  const expectedClient0Total = orderRows
    .filter(r => r[1] === 0)
    .reduce((s, r) => s + r[2], 0);

  const db = {
    githubdb: 1,
    tables: {
      clients: {
        columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }],
        rows: clientRows
      },
      orders: {
        columns: [
          { name: 'id', type: 'INT' },
          { name: 'client_id', type: 'INT' },
          { name: 'amount', type: 'INT' }
        ],
        rows: orderRows
      }
    }
  };

  const t0 = Date.now();
  const res = await executeQuery(db, `
    SELECT c.id AS cid, SUM(o.amount) AS amt
    FROM clients c JOIN orders o ON o.client_id = c.id
    WHERE c.id = 0
    GROUP BY c.id`);
  const elapsed = Date.now() - t0;
  console.log(`[stress] sql JOIN 10k×10k GROUP BY: ${elapsed}ms`);

  assert.ok(elapsed < 60_000, `JOIN query took ${elapsed}ms`);
  assert.equal(res.rows.length, 1, 'expected exactly one group row for client 0');
  assert.equal(res.rows[0][0], 0, 'cid should be 0');
  assert.equal(res.rows[0][1], expectedClient0Total,
    `expected total ${expectedClient0Total}, got ${res.rows[0][1]}`);
});

test('sql: 1,000 sequential INSERTs into same db, correct final row count', async () => {
  const N = 1_000;
  const db = {
    githubdb: 1,
    tables: {
      log: {
        columns: [{ name: 'id', type: 'INT' }, { name: 'msg', type: 'TEXT' }],
        rows: []
      }
    }
  };

  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    await executeQuery(db, 'INSERT INTO log VALUES (:id, :msg)', { id: i, msg: `entry_${i}` });
  }
  const elapsed = Date.now() - t0;
  console.log(`[stress] sql 1,000 sequential INSERTs: ${elapsed}ms`);

  assert.equal(db.tables.log.rows.length, N, `expected ${N} rows`);
  assert.deepEqual(db.tables.log.rows[0], [0, 'entry_0']);
  assert.deepEqual(db.tables.log.rows[N - 1], [N - 1, `entry_${N - 1}`]);
  assert.ok(elapsed < 120_000, `1000 INSERTs took ${elapsed}ms`);
});

test('sql: UPDATE hitting 50,000 of 100,000 rows, check rowCount and spot values', async () => {
  const N = 100_000;
  const rng = mulberry32(0x99aabbcc);

  const rows = Array.from({ length: N }, (_, i) => [i, i % 2, 0]); // flag=i%2, val=0
  const db = {
    githubdb: 1,
    tables: {
      items: {
        columns: [
          { name: 'id', type: 'INT' },
          { name: 'flag', type: 'INT' },
          { name: 'val', type: 'INT' }
        ],
        rows
      }
    }
  };

  const t0 = Date.now();
  const res = await executeQuery(db, 'UPDATE items SET val = 99 WHERE flag = 1');
  const elapsed = Date.now() - t0;
  console.log(`[stress] sql UPDATE 50k of 100k rows: ${elapsed}ms rowCount=${res.rowCount}`);

  assert.equal(res.rowCount, N / 2, `expected rowCount=${N / 2}, got ${res.rowCount}`);
  assert.ok(elapsed < 60_000, `UPDATE took ${elapsed}ms`);

  // Spot-check: flag=1 rows should have val=99, flag=0 rows val=0
  const spotCount = 20;
  for (let i = 0; i < spotCount; i++) {
    const idx = Math.floor(rng() * N);
    const row = db.tables.items.rows[idx];
    const expectedVal = row[1] === 1 ? 99 : 0;
    assert.equal(row[2], expectedVal, `row ${idx}: flag=${row[1]} val=${row[2]} expected ${expectedVal}`);
  }
});

// ---------------------------------------------------------------------------
// VECTOR SQL AT SCALE
// ---------------------------------------------------------------------------

test('vectorsql: 20,000 rows VECTOR(64) COSINE_SIM ORDER BY LIMIT 5, top-1 correct', async () => {
  const N = 20_000;
  const DIMS = 64;
  const PLANT_IDX = 14_888;
  const rng = mulberry32(0x42424242);

  const query = randomUnitVector(DIMS, rng);

  // Plant near-duplicate at PLANT_IDX
  const vectors = Array.from({ length: N }, (_, i) => {
    if (i === PLANT_IDX) {
      const perturbed = Float32Array.from(query);
      let norm = 0;
      for (let d = 0; d < DIMS; d++) {
        perturbed[d] += (rng() - 0.5) * 0.005;
        norm += perturbed[d] * perturbed[d];
      }
      norm = Math.sqrt(norm);
      for (let d = 0; d < DIMS; d++) perturbed[d] /= norm;
      return perturbed;
    }
    return randomUnitVector(DIMS, rng);
  });

  const db = {
    githubdb: 1,
    tables: {
      docs: {
        columns: [
          { name: 'id', type: 'INT' },
          { name: 'vec', type: `VECTOR(${DIMS})` }
        ],
        rows: vectors.map((v, i) => [i, encodeVector(v)])
      }
    }
  };

  const queryB64 = encodeVector(query);

  const t0 = Date.now();
  const res = await executeQuery(db,
    `SELECT id, COSINE_SIM(vec, :q) AS score FROM docs ORDER BY score DESC LIMIT 5`,
    { q: queryB64 });
  const elapsed = Date.now() - t0;
  console.log(`[stress] vectorsql 20k×VECTOR(64) COSINE_SIM LIMIT 5: ${elapsed}ms`);

  assert.ok(elapsed < 60_000, `vector SQL search took ${elapsed}ms`);
  assert.equal(res.rows.length, 5);
  assert.equal(res.rows[0][0], PLANT_IDX,
    `expected top-1 id=${PLANT_IDX}, got ${res.rows[0][0]} (score=${res.rows[0][1]})`);
  assert.ok(res.rows[0][1] > 0.999, `top-1 cosine score ${res.rows[0][1]} should be > 0.999`);
});

// ---------------------------------------------------------------------------
// EDGE CASES (fast, deterministic)
// ---------------------------------------------------------------------------

test('edge: special values survive full save/load/SQL round-trip', async () => {
  const dir = await makeTmpDir();
  const db = {
    githubdb: 1,
    tables: {
      edgevals: {
        columns: [
          { name: 'id', type: 'INT' },
          { name: 'ival', type: 'INT' },
          { name: 'fval', type: 'FLOAT' },
          { name: 'bval', type: 'BOOL' },
          { name: 'tval', type: 'TEXT' }
        ],
        rows: [
          [1, 0, -0.000001, false, ''],
          [2, -999, -1.5e-10, false, 'ñandú 漢字 🚀'],
          [3, 0, 0.0, false, "O'Brien"],
          [4, 0, 0.0, false, 'a\'b"c'],
          [5, 0, 0.0, false, 'x'.repeat(10_000)],
          [6, null, null, null, null]
        ]
      }
    }
  };

  await saveDatabase(dir, 'edgedb', db);
  const loaded = await loadDatabase(dir, 'edgedb');

  const t = loaded.tables.edgevals;
  assert.equal(t.rows[0][1], 0);
  assert.ok(Math.abs(t.rows[0][2] - (-0.000001)) < 1e-12, 'negative float');
  assert.equal(t.rows[0][3], false);
  assert.equal(t.rows[0][4], '');
  assert.equal(t.rows[1][4], 'ñandú 漢字 🚀');
  assert.equal(t.rows[2][4], "O'Brien");
  assert.equal(t.rows[3][4], 'a\'b"c');
  assert.equal(t.rows[4][4].length, 10_000, '10KB string length');
  assert.equal(t.rows[5][1], null, 'null int');
  assert.equal(t.rows[5][4], null, 'null text');

  // SQL round-trip: SELECT with parameterized query using the unicode value
  const res = await executeQuery(loaded, 'SELECT tval FROM edgevals WHERE id = :id', { id: 2 });
  assert.equal(res.rows[0][0], 'ñandú 漢字 🚀');

  // O'Brien via param (no SQL escaping needed)
  const res2 = await executeQuery(loaded, 'SELECT id FROM edgevals WHERE tval = :v', { v: "O'Brien" });
  assert.equal(res2.rows[0][0], 3);

  // a'b"c via param
  const res3 = await executeQuery(loaded, 'SELECT id FROM edgevals WHERE tval = :v', { v: 'a\'b"c' });
  assert.equal(res3.rows[0][0], 4);

  console.log('[stress] edge: special values round-trip OK');
});

test('edge: param named like SQL keyword (:select)', async () => {
  const db = {
    githubdb: 1,
    tables: {
      items: {
        columns: [{ name: 'id', type: 'INT' }, { name: 'val', type: 'INT' }],
        rows: [[1, 10], [2, 20]]
      }
    }
  };
  const res = await executeQuery(db, 'SELECT id FROM items WHERE val = :select', { select: 20 });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0][0], 2);
  console.log('[stress] edge: :select param OK');
});

test('edge: param value containing :other does not recurse', async () => {
  const db = {
    githubdb: 1,
    tables: {
      items: {
        columns: [{ name: 'id', type: 'INT' }, { name: 'val', type: 'TEXT' }],
        rows: [[1, 'plain'], [2, ':other']]
      }
    }
  };
  const res = await executeQuery(db, 'SELECT id FROM items WHERE val = :v', { v: ':other' });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0][0], 2);
  console.log('[stress] edge: param value with :other does not recurse OK');
});

test('edge: table with 100 columns INSERT + SELECT round-trip', async () => {
  const NUM_COLS = 100;
  const colDefs = Array.from({ length: NUM_COLS }, (_, i) => `col${i} INT`).join(', ');
  const db = { githubdb: 1, tables: {} };
  await executeQuery(db, `CREATE TABLE wide (${colDefs})`);

  const values = Array.from({ length: NUM_COLS }, (_, i) => i * 3);
  const paramNames = values.map((_, i) => `:c${i}`).join(', ');
  const params = Object.fromEntries(values.map((v, i) => [`c${i}`, v]));
  await executeQuery(db, `INSERT INTO wide VALUES (${paramNames})`, params);

  const res = await executeQuery(db, 'SELECT * FROM wide');
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].length, NUM_COLS);
  for (let i = 0; i < NUM_COLS; i++) {
    assert.equal(res.rows[0][i], i * 3, `col${i} mismatch`);
  }
  console.log('[stress] edge: 100-column table round-trip OK');
});

test('edge: 1,000-row INSERT then DROP TABLE then CREATE TABLE same name', async () => {
  const N = 1_000;
  const db = { githubdb: 1, tables: {} };

  await executeQuery(db, 'CREATE TABLE t (id INT, val TEXT)');
  for (let i = 0; i < N; i++) {
    await executeQuery(db, 'INSERT INTO t VALUES (:id, :val)', { id: i, val: `v${i}` });
  }
  assert.equal(db.tables.t.rows.length, N);

  await executeQuery(db, 'DROP TABLE t');
  assert.equal(db.tables.t, undefined);

  await executeQuery(db, 'CREATE TABLE t (id INT, val TEXT)');
  assert.equal(db.tables.t.rows.length, 0);

  await executeQuery(db, 'INSERT INTO t VALUES (0, :v)', { v: 'fresh' });
  const res = await executeQuery(db, 'SELECT id, val FROM t');
  assert.equal(res.rows.length, 1);
  assert.deepEqual(res.rows[0], [0, 'fresh']);
  console.log('[stress] edge: DROP+CREATE same name OK');
});

test('edge: saveDatabase with empty tables', async () => {
  const dir = await makeTmpDir();
  const db = { githubdb: 1, tables: {} };
  const files = await saveDatabase(dir, 'empty', db);
  assert.deepEqual(files, ['empty.json']);
  const loaded = await loadDatabase(dir, 'empty');
  assert.deepEqual(loaded.tables, {});
  console.log('[stress] edge: empty tables save+load OK');
});

test('edge: cleanupResults 1,000 files (500 old, 500 fresh) → 500 remain', async () => {
  const dir = await makeTmpDir();
  const now = Date.now();
  const oldTs = new Date(now - 2 * 3_600_000).toISOString(); // 2h ago
  const freshTs = new Date(now - 1_000).toISOString();       // 1s ago

  // Write 500 old + 500 fresh
  const writes = [];
  for (let i = 0; i < 500; i++) {
    writes.push(writeFile(join(dir, `old_${i}.json`), JSON.stringify({ ok: true, ts: oldTs })));
    writes.push(writeFile(join(dir, `fresh_${i}.json`), JSON.stringify({ ok: true, ts: freshTs })));
  }
  await Promise.all(writes);

  const t0 = Date.now();
  await cleanupResults(dir, 3_600_000); // maxAge = 1h
  const elapsed = Date.now() - t0;
  console.log(`[stress] edge: cleanupResults 1000 files: ${elapsed}ms`);

  const remaining = await readdir(dir);
  assert.equal(remaining.length, 500, `expected 500 remaining, got ${remaining.length}`);
  for (const f of remaining) {
    assert.ok(f.startsWith('fresh_'), `unexpected file: ${f}`);
  }
});

// ---------------------------------------------------------------------------
// runQuery FULL PATH AT SCALE
// ---------------------------------------------------------------------------

test('runQuery: full path 10k-row db: SELECT + INSERT + bad SQL + dim mismatch', async () => {
  const root = await makeTmpDir();
  const dataDir = join(root, 'data');
  const resultsDir = join(root, 'results');
  await mkdir(dataDir);
  await mkdir(resultsDir);

  const N = 10_000;
  const noEmbed = { embedPassage: null, embedQuery: null };

  // Build initial db with 10k rows
  const db = {
    githubdb: 1,
    tables: {
      items: {
        columns: [{ name: 'id', type: 'INT' }, { name: 'val', type: 'TEXT' }],
        rows: Array.from({ length: N }, (_, i) => [i, `item_${i}`])
      }
    }
  };
  await saveDatabase(dataDir, 'testdb', db);

  // 1. SELECT
  const t0 = Date.now();
  await runQuery(
    { id: 'sel1', db: 'testdb', sql: 'SELECT id, val FROM items WHERE id < 5 ORDER BY id' },
    { dataDir, resultsDir, embedFns: noEmbed }
  );
  const selElapsed = Date.now() - t0;
  console.log(`[stress] runQuery SELECT 10k-row db: ${selElapsed}ms`);

  const selRes = JSON.parse(await readFile(join(resultsDir, 'sel1.json'), 'utf8'));
  assert.equal(selRes.ok, true);
  assert.equal(selRes.rowCount, 5);
  assert.deepEqual(selRes.rows[0], [0, 'item_0']);
  assert.deepEqual(selRes.rows[4], [4, 'item_4']);

  // 2. INSERT
  await runQuery(
    { id: 'ins1', db: 'testdb', sql: 'INSERT INTO items VALUES (:id, :val)', params: { id: N, val: 'new_item' } },
    { dataDir, resultsDir, embedFns: noEmbed }
  );
  const insRes = JSON.parse(await readFile(join(resultsDir, 'ins1.json'), 'utf8'));
  assert.equal(insRes.ok, true);
  assert.equal(insRes.rowCount, 1);

  // Verify persisted
  const afterInsert = await loadDatabase(dataDir, 'testdb');
  assert.equal(afterInsert.tables.items.rows.length, N + 1);
  assert.deepEqual(afterInsert.tables.items.rows[N], [N, 'new_item']);

  // 3. Bad SQL → ok:false
  await runQuery(
    { id: 'bad1', db: 'testdb', sql: 'SELEKT garbage' },
    { dataDir, resultsDir, embedFns: noEmbed }
  );
  const badRes = JSON.parse(await readFile(join(resultsDir, 'bad1.json'), 'utf8'));
  assert.equal(badRes.ok, false);
  assert.equal(typeof badRes.error, 'string');

  // 4. Dimension mismatch on a vector table
  await runQuery(
    { id: 'cre1', db: 'vecdb', sql: 'CREATE TABLE vecs (id INT, v VECTOR(3))' },
    { dataDir, resultsDir, embedFns: noEmbed }
  );
  const creRes = JSON.parse(await readFile(join(resultsDir, 'cre1.json'), 'utf8'));
  assert.equal(creRes.ok, true);

  await runQuery(
    { id: 'dim1', db: 'vecdb', sql: 'INSERT INTO vecs VALUES (1, :v)', params: { v: [1, 2] } },
    { dataDir, resultsDir, embedFns: noEmbed }
  );
  const dimRes = JSON.parse(await readFile(join(resultsDir, 'dim1.json'), 'utf8'));
  assert.equal(dimRes.ok, false);
  assert.match(dimRes.error, /expected 3, got 2/);

  // Verify vecdb data untouched (no rows after failed insert)
  const vecDbAfter = await loadDatabase(dataDir, 'vecdb');
  assert.equal(vecDbAfter.tables.vecs.rows.length, 0, 'vec table must be empty after failed insert');

  // Result files present for each id
  const resultFiles = await readdir(resultsDir);
  for (const id of ['sel1', 'ins1', 'bad1', 'cre1', 'dim1']) {
    assert.ok(resultFiles.includes(`${id}.json`), `result file ${id}.json missing`);
  }

  console.log('[stress] runQuery full path 10k-row db: all assertions OK');
});
