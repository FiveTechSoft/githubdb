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

test('loadDatabase rejects invalid database names', async () => {
  await assert.rejects(loadDatabase(dir, '../escape'), /Invalid database name/);
  await assert.rejects(loadDatabase(dir, 'my.db'), /Invalid database name/);
});

test('saveDatabase rejects invalid database names', async () => {
  await assert.rejects(saveDatabase(dir, 'a/b', baseDb()), /Invalid database name/);
});

test('shard files respect threshold with long table names', async () => {
  const tname = 't'.repeat(120);
  const db = { githubdb: 1, tables: { [tname]: {
    columns: [{ name: 'id', type: 'INT' }, { name: 'v', type: 'TEXT' }],
    rows: Array.from({ length: 20 }, (_, i) => [i, 'y'.repeat(30)])
  } } };
  await saveDatabase(dir, 'mydb', db, { shardThreshold: 450 });
  const base = JSON.parse(await readFile(join(dir, 'mydb.json'), 'utf8'));
  for (const f of base.tables[tname].shards) {
    const size = (await readFile(join(dir, f), 'utf8')).length;
    assert.ok(size <= 450, `${f} is ${size} bytes`);
  }
});
