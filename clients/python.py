#!/usr/bin/env python3
"""githubDB client example: send a query and poll for the result.

Usage:
    GITHUB_TOKEN=... python3 python.py OWNER "SELECT * FROM clients" [db]
"""
import json
import os
import sys
import time
import urllib.request
import uuid

def query(owner, sql, db="example", repo="githubdb", branch="main",
          params=None, timeout=120, interval=3):
    qid = str(uuid.uuid4())
    payload = {"event_type": "query",
               "client_payload": {"id": qid, "db": db, "sql": sql,
                                   "params": params or {}}}
    req = urllib.request.Request(
        f"https://api.github.com/repos/{owner}/{repo}/dispatches",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
                 "Accept": "application/vnd.github+json"},
        method="POST")
    urllib.request.urlopen(req)

    url = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/results/{qid}.json"
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(interval)
        try:
            with urllib.request.urlopen(url) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
    raise TimeoutError(f"no result after {timeout}s (id={qid})")

if __name__ == "__main__":
    owner, sql = sys.argv[1], sys.argv[2]
    db = sys.argv[3] if len(sys.argv) > 3 else "example"
    print(json.dumps(query(owner, sql, db), indent=2, ensure_ascii=False))
