#!/usr/bin/env bash
# githubDB client example: send a query and poll for the result.
# Usage: GITHUB_TOKEN=... OWNER=you ./curl.sh "SELECT * FROM clients" [db]
set -euo pipefail

SQL="${1:?usage: curl.sh \"SQL\" [db]}"
DB="${2:-example}"
OWNER="${OWNER:?set OWNER to your GitHub user/org}"
REPO="${REPO:-githubdb}"
BRANCH="${BRANCH:-main}"
ID="$(uuidgen | tr 'A-Z' 'a-z')"

curl -fsS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$OWNER/$REPO/dispatches" \
  -d "$(printf '{"event_type":"query","client_payload":{"id":"%s","db":"%s","sql":%s}}' \
        "$ID" "$DB" "$(printf '%s' "$SQL" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"

echo "query id: $ID — polling..."
URL="https://raw.githubusercontent.com/$OWNER/$REPO/$BRANCH/results/$ID.json"
for i in $(seq 1 40); do
  sleep 3
  if RESULT="$(curl -fsS "$URL" 2>/dev/null)"; then
    echo "$RESULT"
    exit 0
  fi
done
echo "timeout after 120s" >&2
exit 1
