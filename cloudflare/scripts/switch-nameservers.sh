#!/usr/bin/env bash
# Point loopa.sh (registered at Vercel) at the Cloudflare nameservers assigned
# to its zone. Run setup-dns.sh first so every record already exists on
# Cloudflare when resolvers start asking it.
#
# Undo: re-run with --revert to go back to Vercel's default nameservers.
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="loopa.sh"
VERCEL_TEAM="team_GwX5sbUyiNZZ3rynkV4yc5GD"   # ion-petropoulos-projects
CF_TOKEN="$(tr -d '[:space:]' < .cf-token)"
VERCEL_TOKEN="$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/Library/Application Support/com.vercel.cli/auth.json")))["token"])')"

if [[ "${1:-}" == "--revert" ]]; then
  NAMESERVERS="[]"
  echo "Reverting $DOMAIN to Vercel's default nameservers…"
else
  NAMESERVERS="$(curl -sS -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/zones?name=$DOMAIN" \
    | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; assert r, "zone not found — run setup-dns.sh first"; print(json.dumps(r[0]["name_servers"]))')"
  echo "Setting $DOMAIN nameservers to ${NAMESERVERS}…"
fi

RESP="$(mktemp)"
STATUS="$(curl -sS -o "$RESP" -w '%{http_code}' -X PATCH \
  "https://api.vercel.com/v1/registrar/domains/$DOMAIN/nameservers?teamId=$VERCEL_TEAM" \
  -H "Authorization: Bearer $VERCEL_TOKEN" -H "Content-Type: application/json" \
  -d "{\"nameservers\":$NAMESERVERS}")"

if [[ "$STATUS" == "204" || "$STATUS" == "200" ]]; then
  echo "Done (HTTP $STATUS). Propagation usually takes minutes, sometimes a few hours."
else
  echo "Failed (HTTP $STATUS):"; cat "$RESP"; echo; exit 1
fi
