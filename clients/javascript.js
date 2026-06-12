#!/usr/bin/env node
// githubDB client example: send a query and poll for the result.
// Usage: GITHUB_TOKEN=... node javascript.js OWNER "SELECT * FROM clients" [db]
import { randomUUID } from 'node:crypto';

export async function query(owner, sql, {
  db = 'example', repo = 'githubdb', branch = 'main',
  params = {}, timeoutMs = 120_000, intervalMs = 3_000
} = {}) {
  const id = randomUUID();
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json'
    },
    body: JSON.stringify({
      event_type: 'query',
      client_payload: { id, db, sql, params }
    })
  });
  if (!res.ok) throw new Error(`dispatch failed: ${res.status} ${await res.text()}`);

  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/results/${id}.json`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    const poll = await fetch(url);
    if (poll.ok) return poll.json();
  }
  throw new Error(`no result after ${timeoutMs / 1000}s (id=${id})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [owner, sql, db] = process.argv.slice(2);
  console.log(JSON.stringify(await query(owner, sql, { db: db ?? 'example' }), null, 2));
}
