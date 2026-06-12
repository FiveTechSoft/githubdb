// engine/storage.js
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_SHARD_THRESHOLD = 40 * 1024 * 1024; // 40 MB

export async function loadDatabase(dataDir, name) {
  const path = join(dataDir, `${name}.json`);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`Database '${name}' not found`);
    throw e;
  }
  const db = JSON.parse(raw);
  if (db.githubdb !== 1) {
    throw new Error(`Unsupported format version in database '${name}'`);
  }
  for (const table of Object.values(db.tables)) {
    if (table.shards) {
      for (const shardFile of table.shards) {
        const shard = JSON.parse(await readFile(join(dataDir, shardFile), 'utf8'));
        table.rows = table.rows.concat(shard.rows);
      }
      delete table.shards; // in-memory model is always merged; saveDatabase re-shards
    }
  }
  return db;
}

export async function saveDatabase(dataDir, name, db, opts = {}) {
  const threshold = opts.shardThreshold ?? DEFAULT_SHARD_THRESHOLD;
  const written = [];

  // Work on a structural copy so the caller's object is not mutated.
  const out = { githubdb: 1, tables: {} };
  for (const [tname, table] of Object.entries(db.tables)) {
    out.tables[tname] = { ...table, rows: table.rows, shards: undefined };
    delete out.tables[tname].shards;
  }

  let shardIndex = 0;
  const shardFiles = [];

  // Shard tables (largest first) until the base file fits under the threshold.
  while (Buffer.byteLength(JSON.stringify(out)) > threshold) {
    const candidates = Object.entries(out.tables)
      .filter(([, t]) => t.rows.length > 0)
      .sort((a, b) => JSON.stringify(b[1].rows).length - JSON.stringify(a[1].rows).length);
    if (candidates.length === 0) {
      throw new Error('Database row too large to fit in a single file');
    }
    const [tname, table] = candidates[0];
    const rows = table.rows;
    table.rows = [];
    table.shards = [];
    let chunk = [];
    let chunkSize = 40; // envelope overhead
    const flush = async () => {
      if (chunk.length === 0) return;
      shardIndex += 1;
      const file = `${name}.${String(shardIndex).padStart(3, '0')}.json`;
      await writeFile(join(dataDir, file), JSON.stringify({ table: tname, rows: chunk }));
      table.shards.push(file);
      shardFiles.push(file);
      written.push(file);
      chunk = [];
      chunkSize = 40;
    };
    for (const row of rows) {
      const rowSize = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (chunk.length > 0 && chunkSize + rowSize > threshold) await flush();
      if (rowSize > threshold) {
        throw new Error('Database row too large to fit in a single file');
      }
      chunk.push(row);
      chunkSize += rowSize;
    }
    await flush();
  }

  await writeFile(join(dataDir, `${name}.json`), JSON.stringify(out, null, 1));
  written.unshift(`${name}.json`);

  // Remove stale shard files from previous saves.
  const keep = new Set(shardFiles);
  const shardRe = new RegExp(`^${name}\\.\\d{3}\\.json$`);
  for (const f of await readdir(dataDir)) {
    if (shardRe.test(f) && !keep.has(f)) await unlink(join(dataDir, f));
  }
  return written;
}
