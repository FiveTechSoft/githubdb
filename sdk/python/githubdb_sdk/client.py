"""
GithubDB client: fetch, cache, and search githubDB databases.
"""

import json
import time
import uuid
import urllib.request
import urllib.error
from .errors import GithubDBError
from .table import Table


# ---------------------------------------------------------------------------
# Default HTTP transport (urllib-based, no third-party deps)
# ---------------------------------------------------------------------------

def _default_transport(method: str, url: str, headers: dict, body: bytes | None):
    """urllib-based HTTP transport.

    Returns:
        (status_code: int, body: bytes)
    """
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


# ---------------------------------------------------------------------------
# GithubDB client
# ---------------------------------------------------------------------------

class GithubDB:
    """githubDB read (and query-dispatch) client.

    Args:
        owner: GitHub username or organisation.
        repo: repository name (default "githubdb").
        branch: branch or ref (default "main").
        token: GitHub personal access token; enables private repo access and query().
        transport: injectable callable ``(method, url, headers, body) -> (status, bytes)``.
                   Defaults to urllib-based implementation.
        embedder: injectable callable ``(str) -> list[float]`` for text search.
                  Defaults to lazy sentence-transformers loading.
    """

    def __init__(
        self,
        owner: str,
        repo: str = "githubdb",
        branch: str = "main",
        token: str | None = None,
        transport=None,
        embedder=None,
    ):
        self._owner = owner
        self._repo = repo
        self._branch = branch
        self._token = token
        self._transport = transport or _default_transport
        self._embedder = embedder
        self._cache: dict[str, dict] = {}  # db_name -> parsed db JSON

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def table(self, db: str, name: str) -> Table:
        """Return a Table object for the given database and table name.

        Fetches and caches the database JSON on first call; subsequent calls
        use the cache.

        Args:
            db: database slug (filename without .json).
            name: table name within the database.

        Returns:
            Table instance.

        Raises:
            GithubDBError: if the database or table is not found.
        """
        db_data = self._load_db(db)
        tables = {t["name"]: t for t in db_data.get("tables", [])}
        if name not in tables:
            raise GithubDBError(f"Table '{name}' not found in database '{db}'")
        tbl = tables[name]
        columns = tbl.get("columns", [])
        rows = list(tbl.get("rows", []))

        # Merge shards (sequential is fine per spec)
        for shard_url in tbl.get("shards", []):
            shard_data = self._fetch_json_url(shard_url)
            rows.extend(shard_data.get("rows", []))

        return Table(name, db, columns, rows, embedder=self._embedder)

    def refresh(self, db: str) -> None:
        """Invalidate and re-fetch the database cache entry.

        Args:
            db: database slug to refresh.
        """
        self._cache.pop(db, None)
        self._load_db(db)

    def query(
        self,
        db: str,
        sql: str,
        params=None,
        timeout: int = 120,
        interval: int = 3,
        sleep=None,
    ):
        """Dispatch a SQL query via repository_dispatch and poll for results.

        Requires a token.

        Args:
            db: database slug.
            sql: SQL statement.
            params: optional dict of query parameters (default {}).
            timeout: seconds before raising a timeout error.
            interval: polling interval in seconds.
            sleep: injectable sleep callable (default time.sleep).

        Returns:
            Parsed JSON result dict.

        Raises:
            GithubDBError: if no token, or if polling times out.
        """
        if not self._token:
            raise GithubDBError("A token is required to send queries")

        if sleep is None:
            sleep = time.sleep
        if params is None:
            params = {}

        query_id = str(uuid.uuid4())

        # POST repository_dispatch
        dispatch_url = (
            f"https://api.github.com/repos/{self._owner}/{self._repo}/dispatches"
        )
        payload = json.dumps(
            {
                "event_type": "query",
                "client_payload": {
                    "id": query_id,
                    "db": db,
                    "sql": sql,
                    "params": params,
                },
            }
        ).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        }
        status, _ = self._transport("POST", dispatch_url, headers, payload)
        if status not in (200, 201, 202, 204):
            raise GithubDBError(
                f"Failed to dispatch query (HTTP {status})"
            )

        # Poll for result
        result_url = (
            f"https://raw.githubusercontent.com/{self._owner}/{self._repo}/"
            f"{self._branch}/results/{query_id}.json"
        )
        elapsed = 0
        while elapsed < timeout:
            sleep(interval)
            elapsed += interval
            status, body = self._transport("GET", result_url, {}, None)
            if status == 200:
                return json.loads(body)

        raise GithubDBError(
            f"Query timed out after {timeout}s (id={query_id}). "
            "The result may arrive later; fetch it manually from "
            f"results/{query_id}.json"
        )

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _load_db(self, db: str) -> dict:
        """Load (and cache) a database by slug."""
        if db in self._cache:
            return self._cache[db]
        db_data = self._fetch_db(db)
        self._cache[db] = db_data
        return db_data

    def _fetch_db(self, db: str) -> dict:
        """Fetch the database JSON from GitHub."""
        if self._token:
            url = (
                f"https://api.github.com/repos/{self._owner}/{self._repo}/"
                f"contents/data/{db}.json?ref={self._branch}"
            )
            headers = {
                "Accept": "application/vnd.github.raw+json",
                "Authorization": f"Bearer {self._token}",
            }
        else:
            url = (
                f"https://raw.githubusercontent.com/{self._owner}/{self._repo}/"
                f"{self._branch}/data/{db}.json"
            )
            headers = {}

        status, body = self._transport("GET", url, headers, None)
        if status == 404:
            raise GithubDBError(f"Database '{db}' not found")
        if status != 200:
            raise GithubDBError(f"Unexpected HTTP {status} fetching database '{db}'")

        data = json.loads(body)
        if data.get("githubdb") != 1:
            raise GithubDBError(
                f"Database '{db}' does not look like a valid githubDB file "
                f"(githubdb version field missing or not 1)"
            )
        return data

    def _fetch_json_url(self, url: str) -> dict:
        """Fetch arbitrary JSON URL (used for shards)."""
        status, body = self._transport("GET", url, {}, None)
        if status != 200:
            raise GithubDBError(f"Failed to fetch shard (HTTP {status}): {url}")
        return json.loads(body)
