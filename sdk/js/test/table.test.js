import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GithubDB } from '../src/client.js';
import { encodeVector } from '../src/vectors.js';

// ── Vector fixture (3-dim) ────────────────────────────────────────────────────
// We plant 4 rows with known vectors and one with null.
// Query vector = [1, 0, 0]
// Scores: v1=[1,0,0]→1.0, v2=[0,1,0]→0.0, v3=[0.6,0.8,0]→0.6, v4=[−1,0,0]→−1.0, null→skip
// Expected order: v1 (score 1.0), v3 (0.6), v2 (0.0), v4 (−1.0)

const V1 = [1, 0, 0];      // score 1.0
const V2 = [0, 1, 0];      // score 0.0
const V3 = [0.6, 0.8, 0];  // score 0.6 (normalized: [0.6,0.8,0] already unit-ish... dot with [1,0,0]=0.6)
const V4 = [-1, 0, 0];     // score -1.0

function makeVectorDB(extraRows = []) {
  return {
    githubdb: 1,
    tables: {
      plants: {
        columns: [
          { name: 'VECTOR(3)', type: 'BLOB' },
          { name: 'name', type: 'TEXT' },
          { name: 'score_hint', type: 'REAL' }
        ],
        rows: [
          [encodeVector(V1), 'Alpha', 1.0],
          [encodeVector(V2), 'Beta', 0.0],
          [encodeVector(V3), 'Gamma', 0.6],
          [encodeVector(V4), 'Delta', -1.0],
          [null, 'NullRow', null],   // should be skipped
          ...extraRows
        ]
      }
    }
  };
}

function capturedFetch(urlMap) {
  const calls = [];
  const fn = async (url, opts) => {
    const key = typeof url === 'string' ? url : url.toString();
    calls.push({ url: key, opts });
    if (key in urlMap) {
      const val = urlMap[key];
      if (val === 404) {
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => (typeof val === 'function' ? val() : val),
        text: async () => JSON.stringify(typeof val === 'function' ? val() : val)
      };
    }
    throw new Error(`Unexpected fetch: ${key}`);
  };
  fn.calls = calls;
  return fn;
}

async function getVectorTable() {
  const url = 'https://raw.githubusercontent.com/alice/githubdb/main/data/vecdb.json';
  const fetch = capturedFetch({ [url]: makeVectorDB() });
  const gdb = new GithubDB({ owner: 'alice', fetch });
  return gdb.table('vecdb', 'plants');
}

// ── objects() ─────────────────────────────────────────────────────────────────

describe('Table.objects()', () => {
  it('returns array of objects keyed by column names', async () => {
    const url = 'https://raw.githubusercontent.com/alice/githubdb/main/data/mydb.json';
    const SIMPLE_DB = {
      githubdb: 1,
      tables: {
        items: {
          columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }],
          rows: [[1, 'Alpha'], [2, 'Beta']]
        }
      }
    };
    const fetch = capturedFetch({ [url]: SIMPLE_DB });
    const gdb = new GithubDB({ owner: 'alice', fetch });
    const table = await gdb.table('mydb', 'items');
    const objs = table.objects();
    assert.deepEqual(objs, [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' }
    ]);
  });
});

// ── search with precomputed vector ────────────────────────────────────────────

describe('Table.search() - precomputed vector', () => {
  it('returns results in descending cosine score order', async () => {
    const table = await getVectorTable();
    const results = await table.search(V1, { limit: 10 });
    const names = results.map(r => r.row.name);
    // Expected order: Alpha (1.0), Gamma (0.6), Beta (0.0), Delta (-1.0)
    assert.deepEqual(names, ['Alpha', 'Gamma', 'Beta', 'Delta']);
  });

  it('respects limit', async () => {
    const table = await getVectorTable();
    const results = await table.search(V1, { limit: 2 });
    assert.equal(results.length, 2);
    assert.equal(results[0].row.name, 'Alpha');
    assert.equal(results[1].row.name, 'Gamma');
  });

  it('filters with where predicate before ranking', async () => {
    const table = await getVectorTable();
    // Exclude Alpha (score 1.0) via where filter
    const results = await table.search(V1, {
      limit: 10,
      where: row => row.name !== 'Alpha'
    });
    // Alpha excluded, so top is Gamma
    assert.ok(!results.find(r => r.row.name === 'Alpha'), 'Alpha should be excluded');
    assert.equal(results[0].row.name, 'Gamma');
  });

  it('skips rows with null vector cell', async () => {
    const table = await getVectorTable();
    const results = await table.search(V1, { limit: 10 });
    assert.ok(!results.find(r => r.row.name === 'NullRow'), 'NullRow should be skipped');
  });

  it('score for top result is approximately 1.0', async () => {
    const table = await getVectorTable();
    const results = await table.search(V1, { limit: 1 });
    assert.ok(Math.abs(results[0].score - 1.0) < 1e-4, `Expected score ~1.0, got ${results[0].score}`);
  });

  it('score for Gamma is approximately 0.6', async () => {
    const table = await getVectorTable();
    const results = await table.search(V1, { limit: 10 });
    const gamma = results.find(r => r.row.name === 'Gamma');
    assert.ok(gamma, 'Gamma should be in results');
    assert.ok(Math.abs(gamma.score - 0.6) < 1e-4, `Expected ~0.6, got ${gamma.score}`);
  });
});

// ── search with base64 query vector ──────────────────────────────────────────

describe('Table.search() - base64 query', () => {
  it('accepts a base64 string as query vector', async () => {
    const table = await getVectorTable();
    const b64 = encodeVector(V1);
    const results = await table.search(b64, { limit: 1 });
    assert.equal(results[0].row.name, 'Alpha');
  });
});

// ── dims mismatch ─────────────────────────────────────────────────────────────

describe('Table.search() - dimension mismatch', () => {
  it('throws when query vector has wrong dimensions', async () => {
    const table = await getVectorTable();
    const wrongDims = [1, 0, 0, 0]; // 4-dim vs 3-dim
    await assert.rejects(
      () => table.search(wrongDims),
      /dimension mismatch|expected 3.*got 4|got 4.*expected 3/i
    );
  });
});

// ── no VECTOR column ──────────────────────────────────────────────────────────

describe('Table.search() - no VECTOR column', () => {
  it('throws when table has no VECTOR column', async () => {
    const noVecDB = {
      githubdb: 1,
      tables: {
        simple: {
          columns: [{ name: 'id', type: 'INTEGER' }],
          rows: [[1]]
        }
      }
    };
    const url = 'https://raw.githubusercontent.com/alice/githubdb/main/data/novec.json';
    const fetch = capturedFetch({ [url]: noVecDB });
    const gdb = new GithubDB({ owner: 'alice', fetch });
    const table = await gdb.table('novec', 'simple');
    await assert.rejects(
      () => table.search([1, 0, 0]),
      { message: "Table 'simple' has no VECTOR column" }
    );
  });
});

// ── search with text + fake embedder ─────────────────────────────────────────

describe('Table.search() - text query with injected embedder', () => {
  it('calls embedder with the raw text and uses returned vector', async () => {
    const url = 'https://raw.githubusercontent.com/alice/githubdb/main/data/vecdb.json';
    const fetch = capturedFetch({ [url]: makeVectorDB() });

    const embedderCalls = [];
    const fakeEmbedder = async (text) => {
      embedderCalls.push(text);
      return V1; // returns the top-scoring vector
    };

    const gdb = new GithubDB({ owner: 'alice', fetch, embedder: fakeEmbedder });
    const table = await gdb.table('vecdb', 'plants');
    const results = await table.search('find plants', { limit: 1 });

    // Embedder called with the raw text string
    assert.equal(embedderCalls.length, 1);
    assert.equal(embedderCalls[0], 'find plants');

    // Result should be Alpha (V1 = top match)
    assert.equal(results[0].row.name, 'Alpha');
  });
});

// ── embedder missing (lazy import failure path) ───────────────────────────────

describe('Table.search() - no embedder, import fails', () => {
  it('throws instructive error with npm install hint when embedder missing and import fails', async () => {
    const url = 'https://raw.githubusercontent.com/alice/githubdb/main/data/vecdb.json';
    const fetch = capturedFetch({ [url]: makeVectorDB() });

    // Inject a loader that simulates failed import
    const failingLoader = async () => {
      throw new Error('Cannot find module');
    };

    const gdb = new GithubDB({ owner: 'alice', fetch, embedder: null, _pipelineLoader: failingLoader });
    const table = await gdb.table('vecdb', 'plants');

    await assert.rejects(
      () => table.search('hello world'),
      (err) => {
        assert.ok(err.message.includes('npm install @huggingface/transformers'),
          `Error should mention npm install, got: ${err.message}`);
        return true;
      }
    );
  });
});

// ── query() ───────────────────────────────────────────────────────────────────

describe('GithubDB.query()', () => {
  it('throws when no token provided', async () => {
    const gdb = new GithubDB({ owner: 'alice', fetch: async () => {} });
    await assert.rejects(
      () => gdb.query('mydb', 'SELECT 1'),
      { message: 'A token is required to send queries' }
    );
  });

  it('happy path: dispatch, polls until result ready', async () => {
    let pollCount = 0;
    const resultPayload = { rows: [[42]], columns: [{ name: 'n', type: 'INTEGER' }] };

    const sleepCalls = [];
    const fakeSleep = (ms) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    };

    const fakeFetch = async (url, opts) => {
      const key = typeof url === 'string' ? url : url.toString();

      // Dispatch endpoint
      if (key === 'https://api.github.com/repos/alice/githubdb/dispatches') {
        return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
      }

      // Result polling: first two calls return 404, third returns 200
      if (key.startsWith('https://raw.githubusercontent.com/alice/githubdb/main/results/')) {
        pollCount++;
        if (pollCount < 3) {
          return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
        }
        return {
          ok: true, status: 200,
          json: async () => resultPayload,
          text: async () => JSON.stringify(resultPayload)
        };
      }

      throw new Error(`Unexpected fetch: ${key}`);
    };

    const gdb = new GithubDB({ owner: 'alice', token: 'tok', fetch: fakeFetch });
    const result = await gdb.query('mydb', 'SELECT 42 AS n', {}, {
      timeoutMs: 30000,
      intervalMs: 100,
      sleep: fakeSleep
    });

    assert.deepEqual(result, resultPayload);
    assert.equal(pollCount, 3, 'Should have polled 3 times (2 misses + 1 hit)');
    assert.equal(sleepCalls.length, 2, 'Sleep called for the 2 failed polls');
  });

  it('includes the query id in timeout error', async () => {
    const fakeSleep = () => Promise.resolve();
    let dispatchedId = null;

    const fakeFetch = async (url, opts) => {
      const key = typeof url === 'string' ? url : url.toString();
      if (key === 'https://api.github.com/repos/alice/githubdb/dispatches') {
        // Extract the id from the dispatch body
        const body = JSON.parse(opts.body);
        dispatchedId = body.client_payload.id;
        return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
      }
      // Always 404 (never ready)
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    };

    const gdb = new GithubDB({ owner: 'alice', token: 'tok', fetch: fakeFetch });

    await assert.rejects(
      () => gdb.query('mydb', 'SELECT 1', {}, {
        timeoutMs: 500,
        intervalMs: 100,
        sleep: fakeSleep
      }),
      (err) => {
        assert.ok(dispatchedId, 'Should have dispatched with an id');
        assert.ok(err.message.includes(dispatchedId),
          `Timeout error should include id ${dispatchedId}, got: ${err.message}`);
        return true;
      }
    );
  });
});
