# githubDB + XBrowse sample

FiveWin sample showing githubDB as a free cloud database browsed with XBrowse.

## What it does

- **Fast read (CDN)**: fetches `data/<db>.json` from raw.githubusercontent.com — sub-second, no token needed
- **Query (Action)**: sends SQL through GitHub's `repository_dispatch` API, polls for result — 10-30 s, needs `GITHUB_TOKEN`
- **Schema**: displays table/column definitions

## Build

```
cd c:\fwteam\samples\githubdb
build hb32    (or hm64, hg64, etc.)
```

## Run

```
set GITHUB_TOKEN=github_pat_...   (only needed for writes/queries)
set OWNER=YourGitHubUser          (defaults to FiveTechSoft)
githubdb.exe
```

## What you see

XBrowse displays query results with sortable columns, automatic sizing, and cell editing.
The window title shows row count and timing.

## How it works

1. Sends SQL to githubDB via GitHub API
2. githubDB Action wakes up, executes SQL against JSON data files
3. Result written to `results/<id>.json`, committed to repo
4. Client polls the result URL and displays in XBrowse

For reads: data fetched directly from GitHub's CDN (no Action, no token needed on public repos).

## githubDB repo

https://github.com/FiveTechSoft/githubdb
Docs: https://fivetechsoft.github.io/githubdb/
