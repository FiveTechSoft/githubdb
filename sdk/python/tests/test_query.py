"""
Tests for GithubDB.query() — dispatch + polling, no-token, timeout.
"""
import json
import pytest

from githubdb_sdk import GithubDB, GithubDBError

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

DISPATCH_URL = "https://api.github.com/repos/owner/repo/dispatches"


def make_query_transport(dispatch_status=204, poll_responses=None):
    """Build a fake transport for query() tests.

    Args:
        dispatch_status: HTTP status for the POST dispatch.
        poll_responses: list of (status, body_dict) tuples returned in sequence
                        for each GET to the results URL. If shorter than actual
                        calls, last entry is repeated.
    """
    if poll_responses is None:
        poll_responses = [(200, {"result": "ok"})]

    poll_iter = iter(poll_responses)
    last_poll = poll_responses[-1] if poll_responses else (404, {})
    poll_state = {"next": None}

    def transport(method, url, headers, body):
        if method == "POST" and "dispatches" in url:
            return dispatch_status, b""
        if method == "GET" and "results/" in url:
            try:
                status, data = next(poll_iter)
            except StopIteration:
                status, data = last_poll
            return status, json.dumps(data).encode("utf-8")
        return 404, b"not found"

    return transport


class SleepCounter:
    """Fake sleep that counts calls and records durations."""

    def __init__(self):
        self.calls = []

    def __call__(self, duration):
        self.calls.append(duration)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------

class TestQueryHappy:
    def test_query_returns_result(self):
        transport = make_query_transport(
            dispatch_status=204,
            poll_responses=[(404, {}), (404, {}), (200, {"result": "rows", "data": [1, 2, 3]})],
        )
        sleep = SleepCounter()
        gdb = GithubDB("owner", token="tok", transport=transport)
        result = gdb.query("mydb", "SELECT 1", sleep=sleep)
        assert result["result"] == "rows"
        assert result["data"] == [1, 2, 3]

    def test_query_polls_until_200(self):
        """sleep is called at least twice (two 404s before 200)."""
        transport = make_query_transport(
            dispatch_status=204,
            poll_responses=[(404, {}), (404, {}), (200, {"ok": True})],
        )
        sleep = SleepCounter()
        gdb = GithubDB("owner", token="tok", transport=transport)
        gdb.query("mydb", "SELECT 1", sleep=sleep)
        assert len(sleep.calls) >= 2

    def test_query_sleep_interval(self):
        """sleep is called with the configured interval."""
        transport = make_query_transport(
            dispatch_status=204,
            poll_responses=[(200, {"ok": True})],
        )
        sleep = SleepCounter()
        gdb = GithubDB("owner", token="tok", transport=transport)
        gdb.query("mydb", "SELECT 1", interval=7, sleep=sleep)
        assert all(d == 7 for d in sleep.calls)

    def test_query_sends_dispatch_with_correct_payload(self):
        payloads = []

        def transport(method, url, headers, body):
            if method == "POST":
                payloads.append(json.loads(body))
                return 204, b""
            return 200, json.dumps({"ok": True}).encode("utf-8")

        sleep = SleepCounter()
        gdb = GithubDB("owner", token="tok", transport=transport)
        gdb.query("mydb", "SELECT 42", params={"x": 1}, sleep=sleep)

        assert len(payloads) == 1
        payload = payloads[0]
        assert payload["event_type"] == "query"
        assert payload["client_payload"]["db"] == "mydb"
        assert payload["client_payload"]["sql"] == "SELECT 42"
        assert payload["client_payload"]["params"] == {"x": 1}
        # id must be present and look like a UUID
        assert "id" in payload["client_payload"]
        assert len(payload["client_payload"]["id"]) == 36  # UUID4 str length

    def test_query_default_params_is_empty_dict(self):
        payloads = []

        def transport(method, url, headers, body):
            if method == "POST":
                payloads.append(json.loads(body))
                return 204, b""
            return 200, json.dumps({"ok": True}).encode("utf-8")

        sleep = SleepCounter()
        gdb = GithubDB("owner", token="tok", transport=transport)
        gdb.query("mydb", "SELECT 1", sleep=sleep)
        assert payloads[0]["client_payload"]["params"] == {}

    def test_query_polls_correct_url(self):
        """The GET polls raw.githubusercontent.com/…/results/<id>.json"""
        polled_urls = []

        def transport(method, url, headers, body):
            if method == "POST":
                return 204, b""
            polled_urls.append(url)
            return 200, json.dumps({"ok": True}).encode("utf-8")

        sleep = SleepCounter()
        gdb = GithubDB("owner", token="tok", transport=transport)
        gdb.query("mydb", "SELECT 1", sleep=sleep)

        assert len(polled_urls) == 1
        url = polled_urls[0]
        assert "raw.githubusercontent.com" in url
        assert "results/" in url
        assert url.endswith(".json")


# ---------------------------------------------------------------------------
# No token → error
# ---------------------------------------------------------------------------

class TestQueryNoToken:
    def test_no_token_raises(self):
        gdb = GithubDB("owner")
        with pytest.raises(GithubDBError, match="A token is required to send queries"):
            gdb.query("mydb", "SELECT 1")

    def test_no_token_error_message(self):
        gdb = GithubDB("owner")
        with pytest.raises(GithubDBError) as exc_info:
            gdb.query("mydb", "SELECT 1")
        assert "token" in str(exc_info.value).lower()


# ---------------------------------------------------------------------------
# Timeout error includes query id
# ---------------------------------------------------------------------------

class TestQueryTimeout:
    def test_timeout_raises_githubdberror(self):
        transport = make_query_transport(
            dispatch_status=204,
            poll_responses=[(404, {})] * 100,  # always 404
        )
        sleep = SleepCounter()
        gdb = GithubDB("owner", token="tok", transport=transport)
        with pytest.raises(GithubDBError):
            gdb.query("mydb", "SELECT 1", timeout=9, interval=3, sleep=sleep)

    def test_timeout_error_includes_id(self):
        """Timeout error message must include the query UUID."""
        seen_payload_id = {}

        def transport(method, url, headers, body):
            if method == "POST":
                data = json.loads(body)
                seen_payload_id["id"] = data["client_payload"]["id"]
                return 204, b""
            return 404, b"not found"

        sleep = SleepCounter()
        gdb = GithubDB("owner", token="tok", transport=transport)
        with pytest.raises(GithubDBError) as exc_info:
            gdb.query("mydb", "SELECT 1", timeout=9, interval=3, sleep=sleep)

        query_id = seen_payload_id.get("id", "")
        assert query_id, "Transport must have captured the UUID"
        assert query_id in str(exc_info.value), (
            f"Error message should contain query id {query_id!r}, "
            f"got: {str(exc_info.value)!r}"
        )

    def test_timeout_sleep_called_correct_times(self):
        """With timeout=9, interval=3: sleep is called 3 times (at 3, 6, 9s)."""
        transport = make_query_transport(
            dispatch_status=204,
            poll_responses=[(404, {})] * 100,
        )
        sleep = SleepCounter()
        gdb = GithubDB("owner", token="tok", transport=transport)
        with pytest.raises(GithubDBError):
            gdb.query("mydb", "SELECT 1", timeout=9, interval=3, sleep=sleep)
        assert len(sleep.calls) == 3
