/**
 * table.js — Table class for githubdb-sdk
 */
import { decodeVector, toVector, cosineSim } from './vectors.js';
import { embedText } from './embed.js';

const VECTOR_COL_RE = /^VECTOR\((\d+)\)$/;

export class Table {
  /**
   * @param {string} name
   * @param {string} dbName
   * @param {{name:string,type:string}[]} columns
   * @param {any[][]} rows
   * @param {Function|null} embedder - constructor-injected embedder (optional)
   * @param {Function|null} _pipelineLoader - injectable for testing the lazy import path
   */
  constructor(name, dbName, columns, rows, embedder, _pipelineLoader) {
    this.name = name;
    this._dbName = dbName;
    this.columns = columns;
    this.rows = rows;
    this._embedder = embedder ?? null;
    this._pipelineLoader = _pipelineLoader ?? null;
  }

  /**
   * Returns rows as an array of plain objects keyed by column names.
   * @returns {Object[]}
   */
  objects() {
    return this.rows.map(row => {
      const obj = {};
      for (let i = 0; i < this.columns.length; i++) {
        obj[this.columns[i].name] = row[i];
      }
      return obj;
    });
  }

  /**
   * Semantic search over the table's VECTOR column.
   *
   * @param {string|number[]|Float32Array} query
   * @param {{limit?:number, where?:Function}} options
   * @returns {Promise<{row:Object, score:number}[]>}
   */
  async search(query, { limit = 10, where = null } = {}) {
    // Find VECTOR column
    const vecColIdx = this.columns.findIndex(c => VECTOR_COL_RE.test(c.type));
    if (vecColIdx === -1) {
      throw new Error(`Table '${this.name}' has no VECTOR column`);
    }

    const match = VECTOR_COL_RE.exec(this.columns[vecColIdx].type);
    const expectedDims = parseInt(match[1], 10);

    // Resolve query vector
    let queryVec;
    if (typeof query === 'string' && !isBase64Vector(query, expectedDims)) {
      // Text query → embed
      if (this._embedder) {
        const result = await this._embedder(query);
        queryVec = new Float32Array(result);
      } else {
        // Lazy import
        const vec = await embedText(query, this._pipelineLoader ?? undefined);
        queryVec = vec;
      }
    } else {
      // Array, Float32Array, or base64 string
      queryVec = toVector(query, expectedDims);
    }

    // Validate dims
    if (queryVec.length !== expectedDims) {
      throw new Error(
        `Vector dimension mismatch: expected ${expectedDims}, got ${queryVec.length}`
      );
    }

    // Build candidate list (convert rows to objects, apply where)
    const candidates = [];
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const cellVal = row[vecColIdx];
      if (cellVal === null || cellVal === undefined) continue; // skip null

      // Decode vector
      let rowVec;
      try {
        rowVec = typeof cellVal === 'string'
          ? decodeVector(cellVal, expectedDims)
          : toVector(cellVal, expectedDims);
      } catch {
        continue; // skip malformed
      }

      const obj = this._rowToObject(row);
      if (where && !where(obj)) continue; // filter before ranking

      const score = cosineSim(queryVec, rowVec);
      candidates.push({ row: obj, score, _origIdx: i });
    }

    // Sort descending by score, stable by original index for ties
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a._origIdx - b._origIdx;
    });

    return candidates.slice(0, limit).map(({ row, score }) => ({ row, score }));
  }

  _rowToObject(row) {
    const obj = {};
    for (let i = 0; i < this.columns.length; i++) {
      obj[this.columns[i].name] = row[i];
    }
    return obj;
  }
}

/**
 * Heuristic: if the string decodes to exactly `dims * 4` bytes it's a base64 vector.
 * Falls back gracefully — if dims unknown, any string could be base64.
 */
function isBase64Vector(str, dims) {
  try {
    const binary = atob(str);
    if (dims !== undefined) {
      return binary.length === dims * 4;
    }
    // If no dims, assume it's base64 if it looks like one
    return binary.length % 4 === 0 && binary.length > 0;
  } catch {
    return false;
  }
}
