#!/usr/bin/env bash
# Deploy the storefront and owner app to Vercel (production) from the repo root, so the workspace
# packages are included. NEXT_PUBLIC_* values are inlined at build time, so re-run this whenever the
# brain's public URL changes (a new Cloudflare quick tunnel).
#
#   BRAIN_PUBLIC_URL=https://xxx.trycloudflare.com scripts/deploy-web.sh [store|owner|both]
set -euo pipefail
cd "$(dirname "$0")/.."

: "${BRAIN_PUBLIC_URL:?set BRAIN_PUBLIC_URL to the public https URL of the brain}"
ORG_ID="${VERCEL_ORG_ID:-team_Etn72hUqGT17AAqVNuULBgIb}"
STDB_URI="${PUBLIC_SPACETIMEDB_URI:-wss://maincloud.spacetimedb.com}"
STDB_DB="${PUBLIC_SPACETIMEDB_DB:-napkin-inc-mayas}"
STORE_URL="${PUBLIC_STORE_URL:-https://napkin-store.vercel.app}"
OWNER_URL="${PUBLIC_OWNER_URL:-https://napkin-owner.vercel.app}"
PHONE_LINE="${PUBLIC_PHONE_LINE-+19064989806}" # the shared Cartesia line every live shop answers on; empty hides it
which="${1:-both}"

deploy() { # <project> <project id>
  VERCEL_ORG_ID="$ORG_ID" VERCEL_PROJECT_ID="$2" npx -y vercel@latest deploy --prod --yes \
    --build-env NEXT_PUBLIC_BRAIN_URL="$BRAIN_PUBLIC_URL" \
    --build-env NEXT_PUBLIC_SPACETIMEDB_URI="$STDB_URI" \
    --build-env NEXT_PUBLIC_SPACETIMEDB_DB="$STDB_DB" \
    --build-env NEXT_PUBLIC_STORE_URL="$STORE_URL" \
    --build-env NEXT_PUBLIC_OWNER_URL="$OWNER_URL" \
    --build-env NEXT_PUBLIC_PHONE_LINE="$PHONE_LINE" \
    --build-env NEXT_PUBLIC_BUSINESS_SLUG=maya-cookies
}

[[ "$which" == store || "$which" == both ]] && deploy napkin-store prj_A1WVgYTDOQqYuPv7rJIOJhxefo2R
[[ "$which" == owner || "$which" == both ]] && deploy napkin-owner prj_Ix1DAhcegnD5Cu3dq1bRkseJG0VJ
echo "store: $STORE_URL  owner: $OWNER_URL  brain: $BRAIN_PUBLIC_URL"
