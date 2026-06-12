import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GithubDB } from '../src/client.js';
import { encodeVector } from '../src/vectors.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SIMPLE_DB = {
  githubdb: 1,
  tables: {
    items: {
      columns: [
        { name: 'id', type: 'INTEGER' },
        { name: 'name', type: 'TEXT' }
      ],
      rows: [
        [1, 'Alpha'],
        [2, 'Beta']
      ]
    }
  }
};

const SHARD1_ROWS = [[3, 'Gamma']];
const SHARD2_ROWS = [[4, 'Delta'], [5, 'Epsilon']];

const SHARDED_DB = {
  githubdb: 1,
  tables: {
    items: {
      columns: [
        { name: 'id', type: 'INTEGER' },
        { name: 'name', type: 'TEXT' }
      ],
      rows: [[1, 'Alpha'], [2, 'Beta']],
      shards: ['items_shard1.json', 'items_shard2.json']
    }
  }
};

const SHARD1_FILE = { rows: SHARD1_ROWS };
const SHARD2_FILE = { rows: SHARD2_ROWS };

// ── Fake fetch helpers ────────────────────────────────────────────────────────

function makeFetch(urlMap) {
  return async (url, opts) => {
    const key = typeof url === 'string' ? url : url.toString();
    // Record calls
    makeFetch._calls = makeFetch._calls || [];
    makeFetch._calls.push({ url: key, opts });

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GithubDB.table() - simple db', () => {
  it('fetches and returns correct columns and rows', async () => {
    const url = 'https://raw.githubusercontent.com/alice/githubdb/main/data/mydb.json';
    const fetch = capturedFetch({ [url]: SIMPLE_DB });
    const gdb = new GithubDB({ owner: 'alice', fetch });
    const table = await gdb.table('mydb', 'items');

    assert.deepEqual(table.columns, [
      { name: 'id', type: 'INTEGER' },
      { name: 'name', type: 'TEXT' }
    ]);
    assert.deepEqual(table.rows, [[1, 'Alpha'], [2, 'Beta']]);
  });

  it('uses raw.githubusercontent.com URL without token', async () => {
    const url = 'https://raw.githubusercontent.com/alice/githubdb/main/data/mydb.json';
    const fetch = capturedFetch({ [url]: SIMPLE_DB });
    const gdb = new GithubDB({ owner: 'alice', fetch });
    await gdb.table('mydb', 'items');
    assert.equal(fetch.calls.length, 1);
    assert.ok(fetch.calls[0].url.startsWith('https://raw.githubusercontent.com/'));
  });
});

describe('GithubDB.table() - 404 error', () => {
  it('throws Database not found on 404', async () => {
    const url = 'https://raw.githubusercontent.com/alice/githubdb/main/data/missing.json';
    const fetch = capturedFetch({ [url]: 404 });
    const gdb = new GithubDB({ owner: 'alice', fetch });
    await assert.rejects(
      () => gdb.table('missing', 'items'),
      { message: "Database 'missing' not found" }
    );
  });
});

describe('GithubDB.table() - unknown table', () => {
  it('throws Table not found for missing table name', async () => {
    const url = 'https://raw.githubusercontent.com/alice/githubdb/main/data/mydb.json';
    const fetch = capturedFetch({ [url]: SIMPLE_DB });
    const gdb = new GithubDB({ owner: 'alice', fetch });
    await assert.rejects(
      () => gdb.table('mydb', 'nonexistent'),
      { message: "Table 'nonexistent' not found in database 'mydb'" }
    );
  });
});

describe('GithubDB.table() - sharded db', () => {
  it('merges shard rows after inline rows in order', async () => {
    const baseUrl = 'https://raw.githubusercontent.com/alice/githubdb/main';
    const fetch = capturedFetch({
      [`${baseUrl}/data/sharddb.json`]: SHARDED_DB,
      [`${baseUrl}/data/items_shard1.json`]: SHARD1_FILE,
      [`${baseUrl}/data/items_shard2.json`]: SHARD2_FILE
    });
    const gdb = new GithubDB({ owner: 'alice', fetch });
    const table = await gdb.table('sharddb', 'items');

    // inline rows first, then shard1, then shard2
    assert.deepEqual(table.rows, [
      [1, 'Alpha'],
      [2, 'Beta'],
      [3, 'Gamma'],
      [4, 'Delta'],
      [5, 'Epsilon']
    ]);
  });
});

describe('GithubDB.table() - caching', () => {
  it('does NOT refetch on second table() call for same db', async () => {
    const url = 'https://raw.githubusercontent.com/alice/githubdb/main/data/mydb.json';
    const fetch = capturedFetch({ [url]: SIMPLE_DB });
    const gdb = new GithubDB({ owner: 'alice', fetch });
    await gdb.table('mydb', 'items');
    await gdb.table('mydb', 'items');
    assert.equal(fetch.calls.filter(c => c.url === url).length, 1);
  });

  it('refetches after refresh()', async () => {
    const url = 'https://raw.githubusercontent.com/alice/githubdb/main/data/mydb.json';
    const fetch = capturedFetch({ [url]: SIMPLE_DB });
    const gdb = new GithubDB({ owner: 'alice', fetch });
    await gdb.table('mydb', 'items');
    await gdb.refresh('mydb');
    await gdb.table('mydb', 'items');
    assert.equal(fetch.calls.filter(c => c.url === url).length, 2);
  });
});

describe('GithubDB.table() - token / private repo', () => {
  it('uses api.github.com URL with auth header when token provided', async () => {
    const apiUrl = 'https://api.github.com/repos/alice/githubdb/contents/data/mydb.json?ref=main';
    const fetch = capturedFetch({ [apiUrl]: SIMPLE_DB });
    const gdb = new GithubDB({ owner: 'alice', token: 'mytoken', fetch });
    await gdb.table('mydb', 'items');

    assert.equal(fetch.calls.length, 1);
    const { url, opts } = fetch.calls[0];
    assert.ok(url.startsWith('https://api.github.com/'), `Expected api.github.com URL, got ${url}`);
    assert.equal(opts?.headers?.['Authorization'], 'Bearer mytoken');
    assert.equal(opts?.headers?.['Accept'], 'application/vnd.github.raw+json');
  });

  it('uses custom repo and branch when specified', async () => {
    const apiUrl = 'https://api.github.com/repos/alice/myrepo/contents/data/mydb.json?ref=dev';
    const fetch = capturedFetch({ [apiUrl]: SIMPLE_DB });
    const gdb = new GithubDB({ owner: 'alice', repo: 'myrepo', branch: 'dev', token: 'tok', fetch });
    await gdb.table('mydb', 'items');
    assert.equal(fetch.calls[0].url, apiUrl);
  });
});
