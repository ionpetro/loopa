#!/usr/bin/env bash
# Create the loopa.sh zone on Cloudflare (free plan) and copy over the DNS
# records that currently live on Vercel DNS. Safe to re-run: the zone and any
# record that already exists are left as they are.
#
# Every record is DNS-only (proxied=false): Vercel and Clerk issue their own
# TLS certificates and need traffic to reach them directly.
#
# api.loopa.sh is NOT created here — it becomes a Worker custom domain
# (wrangler.jsonc "routes"), which creates its own record and certificate.
set -euo pipefail
cd "$(dirname "$0")/.."

ZONE_NAME="loopa.sh"
ACCOUNT_ID="879764153396cfdd33c0d119c90fba79"
TOKEN="$(tr -d '[:space:]' < .cf-token)"
API="https://api.cloudflare.com/client/v4"

cf() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

# --- zone --------------------------------------------------------------------
ZONE_ID="$(cf "$API/zones?name=$ZONE_NAME" | json 'r=d["result"]; print(r[0]["id"] if r else "")')"
if [[ -z "$ZONE_ID" ]]; then
  echo "Creating zone ${ZONE_NAME}…"
  ZONE_ID="$(cf -X POST "$API/zones" \
    -d "{\"name\":\"$ZONE_NAME\",\"account\":{\"id\":\"$ACCOUNT_ID\"},\"type\":\"full\",\"jump_start\":false}" \
    | json 'assert d["success"], d["errors"]; print(d["result"]["id"])')"
else
  echo "Zone $ZONE_NAME already exists ($ZONE_ID)"
fi

# --- records (copied from `vercel dns ls loopa.sh`) ---------------------------
#   name               type   target
RECORDS=(
  "loopa.sh          CNAME  06e61812ce658ff3.vercel-dns-016.com"   # apex → Vercel frontend (flattened)
  "*.loopa.sh        CNAME  cname.vercel-dns-016.com"              # wildcard → Vercel
  "clerk.loopa.sh    CNAME  frontend-api.clerk.services"           # Clerk frontend API
  "accounts.loopa.sh CNAME  accounts.clerk.services"               # Clerk account portal
  "clkmail.loopa.sh  CNAME  mail.ty6yyuzabspi.clerk.services"      # Clerk email
  "clk._domainkey.loopa.sh  CNAME  dkim1.ty6yyuzabspi.clerk.services"
  "clk2._domainkey.loopa.sh CNAME  dkim2.ty6yyuzabspi.clerk.services"
)

for rec in "${RECORDS[@]}"; do
  read -r name type content <<<"$rec"
  existing="$(cf "$API/zones/$ZONE_ID/dns_records?name=$name&type=$type" | json 'print(len(d["result"]))')"
  if [[ "$existing" != "0" ]]; then
    echo "  = $type $name (exists)"
    continue
  fi
  cf -X POST "$API/zones/$ZONE_ID/dns_records" \
    -d "{\"type\":\"$type\",\"name\":\"$name\",\"content\":\"$content\",\"proxied\":false,\"ttl\":1}" \
    | json 'assert d["success"], d["errors"]'
  echo "  + $type $name → $content"
done

# --- result ------------------------------------------------------------------
cf "$API/zones/$ZONE_ID" | json 'r=d["result"]; print("\nZone status:", r["status"]); print("Cloudflare nameservers:", " ".join(r["name_servers"]))'
echo "Next: run cloudflare/scripts/switch-nameservers.sh to point loopa.sh at Cloudflare."
