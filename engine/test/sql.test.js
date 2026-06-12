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

test('tables with reserved-word names are usable', async () => {
  const db = emptyDb();
  await executeQuery(db, 'CREATE TABLE total (id INT, amount FLOAT)');
  await executeQuery(db, 'INSERT INTO total VALUES (1, 9.5)');
  const res = await executeQuery(db, 'SELECT id, amount FROM total');
  assert.deepEqual(res.rows, [[1, 9.5]]);
});

test(':: casts are not treated as named parameters', async () => {
  const res = await executeQuery(sampleDb(),
    "SELECT id::INT AS i FROM clients WHERE id = :id", { id: 1 });
  assert.deepEqual(res.rows, [[1]]);
});
