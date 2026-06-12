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

export async function saveDatabase() {
  throw new Error('Not yet implemented');
}
