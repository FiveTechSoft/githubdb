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

test('CREATE TABLE on a new database creates the file', async () => {
  await runQuery({ id: 'q5', db: 'newdb',
    sql: 'CREATE TABLE t (id INT)' }, opts());
  const db = JSON.parse(await readFile(join(dataDir, 'newdb.json'), 'utf8'));
  assert.deepEqual(db.tables.t.columns, [{ name: 'id', type: 'INT' }]);
  const res = JSON.parse(await readFile(join(resultsDir, 'q5.json'), 'utf8'));
  assert.equal(res.ok, true);
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
