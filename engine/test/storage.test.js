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
