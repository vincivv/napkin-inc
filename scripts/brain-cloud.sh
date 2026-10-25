#!/usr/bin/env bash
# Run the brain for the hosted demo: SpacetimeDB maincloud, the Vercel apps, and the brain's public
# tunnel URL. Secrets still come from .env; these values override the local defaults there.
#
#   BRAIN_PUBLIC_URL=https://xxx.trycloudflare.com scripts/brain-cloud.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${BRAIN_PUBLIC_URL:?set BRAIN_PUBLIC_URL to the public https URL of the brain}"
export SPACETIMEDB_URI="${SPACETIMEDB_URI_CLOUD:-https://maincloud.spacetimedb.com}"
export SPACETIMEDB_DB="${SPACETIMEDB_DB_CLOUD:-napkin-inc-mayas}"
export BRAIN_DATA_DIR="$PWD/services/brain/.data-cloud"
export STORE_PUBLIC_URL="${PUBLIC_STORE_URL:-https://napkin-store.vercel.app}"
export OWNER_APP_URL="${PUBLIC_OWNER_URL:-https://napkin-owner.vercel.app}"
export BRAIN_URL="$BRAIN_PUBLIC_URL"
exec pnpm --filter @napkin/brain start
