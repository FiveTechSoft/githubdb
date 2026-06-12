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
    let db;
    try {
      db = await loadDatabase(dataDir, dbName);
    } catch (e) {
      if (/^Database .* not found/.test(e.message) && /^\s*CREATE\s+TABLE/i.test(sql)) {
        db = { githubdb: 1, tables: {} };
      } else {
        throw e;
      }
    }
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
  try {
    const payload = JSON.parse(process.env.GITHUBDB_PAYLOAD ?? '{}');
    await runQuery(payload, { dataDir: 'data', resultsDir: 'results' });
  } catch (e) {
    console.error('githubDB: fatal:', e);
    process.exit(1);
  }
}
