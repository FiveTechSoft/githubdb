/**
 * client.js — GithubDB client for githubdb-sdk
 * Browser-safe: no node: imports.
 */
import { Table } from './table.js';

export class GithubDB {
  /**
   * @param {{
   *   owner: string,
   *   repo?: string,
   *   branch?: string,
   *   token?: string|null,
   *   fetch?: Function,
   *   embedder?: Function|null,
   *   _pipelineLoader?: Function|null
   * }} options
   */
  constructor({
    owner,
    repo = 'githubdb',
    branch = 'main',
    token = null,
    fetch = globalThis.fetch,
    embedder = null,
    _pipelineLoader = null
  }) {
    this._owner = owner;
    this._repo = repo;
    this._branch = branch;
    this._token = token;
    this._fetch = fetch;
    this._embedder = embedder;
    this._pipelineLoader = _pipelineLoader;
    /** @type {Map<string, object>} per-instance db cache */
    this._cache = new Map();
  }

  /**
   * Fetch (with cache) a database and return the named Table.
   * @param {string} db - database name (maps to data/<db>.json)
   * @param {string} name - table name
   * @returns {Promise<Table>}
   */
  async table(db, name) {
    const dbData = await this._loadDb(db);

    if (!dbData.tables || !(name in dbData.tables)) {
      throw new Error(`Table '${name}' not found in database '${db}'`);
    }

    const tableDef = dbData.tables[name];
    const columns = tableDef.columns ?? [];
    let rows = Array.isArray(tableDef.rows) ? [...tableDef.rows] : [];

    // Merge shards if present
    if (Array.isArray(tableDef.shards) && tableDef.shards.length > 0) {
      const shardRows = await Promise.all(
        tableDef.shards.map(file => this._fetchShard(file))
      );
      for (const sr of shardRows) {
        rows = rows.concat(sr);
      }
    }

    return new Table(name, db, columns, rows, this._embedder, this._pipelineLoader);
  }

  /**
   * Drop cache for `db` and refetch on next access.
   * @param {string} db
   */
  async refresh(db) {
    this._cache.delete(db);
  }

  /**
   * Send a SQL query via repository_dispatch and poll for result.
   *
   * @param {string} db
   * @param {string} sql
   * @param {Object} [params={}]
   * @param {{timeoutMs?:number, intervalMs?:number, sleep?:Function}} [options={}]
   * @returns {Promise<any>}
   */
  async query(db, sql, params = {}, { timeoutMs = 120000, intervalMs = 3000, sleep } = {}) {
    if (!this._token) {
      throw new Error('A token is required to send queries');
    }

    const id = crypto.randomUUID();
    const dispatchUrl = `https://api.github.com/repos/${this._owner}/${this._repo}/dispatches`;
    const resultUrl = `https://raw.githubusercontent.com/${this._owner}/${this._repo}/${this._branch}/results/${id}.json`;

    const sleepFn = sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));

    // POST dispatch
    const dispatchResp = await this._fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        event_type: 'query',
        client_payload: { id, db, sql, params }
      })
    });

    if (!dispatchResp.ok) {
      throw new Error(`Failed to dispatch query: HTTP ${dispatchResp.status}`);
    }

    // Poll for result
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const resp = await this._fetch(resultUrl);
      if (resp.ok) {
        return resp.json();
      }
      // Not ready yet — sleep then retry
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleepFn(intervalMs);
    }

    throw new Error(
      `Query timed out waiting for result. Query id: ${id}. ` +
      `The result may still arrive at results/${id}.json`
    );
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  async _loadDb(db) {
    if (this._cache.has(db)) {
      return this._cache.get(db);
    }

    const url = this._dbUrl(db);
    const opts = this._token
      ? {
          headers: {
            'Accept': 'application/vnd.github.raw+json',
            'Authorization': `Bearer ${this._token}`
          }
        }
      : undefined;

    const resp = await this._fetch(url, opts);

    if (!resp.ok) {
      if (resp.status === 404) {
        throw new Error(`Database '${db}' not found`);
      }
      throw new Error(`Failed to fetch database '${db}': HTTP ${resp.status}`);
    }

    const data = await resp.json();

    if (data.githubdb !== 1) {
      throw new Error(`Invalid githubDB manifest for '${db}': missing githubdb===1`);
    }

    this._cache.set(db, data);
    return data;
  }

  _dbUrl(db) {
    if (this._token) {
      return `https://api.github.com/repos/${this._owner}/${this._repo}/contents/data/${db}.json?ref=${this._branch}`;
    }
    return `https://raw.githubusercontent.com/${this._owner}/${this._repo}/${this._branch}/data/${db}.json`;
  }

  async _fetchShard(file) {
    const url = `https://raw.githubusercontent.com/${this._owner}/${this._repo}/${this._branch}/data/${file}`;
    const resp = await this._fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to fetch shard '${file}': HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return Array.isArray(data.rows) ? data.rows : [];
  }
}
