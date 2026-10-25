#!/usr/bin/env bash
# Keeps the hosted demo up: the brain (maincloud), a Cloudflare quick tunnel, and `stripe listen`.
# A quick tunnel dies when the network drops (Cloudflare forgets it), and its replacement has a new URL.
# This script notices (the public /health fails while the local one answers), opens a new tunnel and
# does the whole URL change by itself: restart the brain with the new URL, redeploy both Vercel apps,
# and point the Cartesia phone agent at it. It also restarts the brain or `stripe listen` if they exit.
#
#   scripts/demo-up.sh            # run in a terminal (or in the background); Ctrl-C stops everything
#
# Logs: .demo/{brain,tunnel,stripe,deploy,cartesia}.log. The URL the apps were last deployed with is
# kept in .demo/deployed-url, so restarting this script with the same tunnel URL skips the redeploy.
# Needs: cloudflared and stripe on PATH or in ~/.local/bin, a logged-in Vercel CLI, and .env.
set -uo pipefail
set -m # every background job gets its own process group, so a restart stops the whole tree
cd "$(dirname "$0")/.."

STATE=.demo
mkdir -p "$STATE"
PATH="$HOME/.local/bin:$PATH"
CARTESIA_ARGS=(--model claude-haiku-5.5 --voice db6b0ed5-d5d3-463d-ae85-518a07d3c2b4 --phone-number-id ap_KugXKLtEEEvLtNcN58QoEz)
CHECK_EVERY=30 # seconds between health checks
FAILS_BEFORE_NEW_TUNNEL=3

say() { printf '%s [demo-up] %s\n' "$(date '+%H:%M:%S')" "$*"; }
envval() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d "\"'"; }
stop() { [[ -n "${1:-}" ]] && kill -- "-$1" 2>/dev/null; return 0; }
alive() { [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null; }
healthy() { curl -sf -m 8 "$1/health" >/dev/null; }

tunnel_pid="" brain_pid="" stripe_pid="" url=""
cleanup() {
  say "stopping"
  stop "$brain_pid"; stop "$tunnel_pid"; stop "$stripe_pid"
  exit 0
}
trap cleanup INT TERM

start_tunnel() {
  stop "$tunnel_pid"
  : >"$STATE/tunnel.log"
  cloudflared tunnel --no-autoupdate --url http://localhost:4000 >>"$STATE/tunnel.log" 2>&1 &
  tunnel_pid=$!
  url=""
  for _ in $(seq 1 60); do
    url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$STATE/tunnel.log" | head -1)
    [[ -n "$url" ]] && break
    sleep 1
  done
  [[ -n "$url" ]] || { say "cloudflared gave no URL; see $STATE/tunnel.log"; return 1; }
  say "tunnel: $url"
}

start_brain() {
  stop "$brain_pid"
  for _ in $(seq 1 20); do lsof -nP -iTCP:4000 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
  BRAIN_PUBLIC_URL="$url" scripts/brain-cloud.sh >>"$STATE/brain.log" 2>&1 &
  brain_pid=$!
  for _ in $(seq 1 60); do healthy http://localhost:4000 && { say "brain up"; return 0; }; sleep 3; done
  say "brain did not answer /health in 3 minutes; see $STATE/brain.log"
  return 1
}

start_stripe() {
  command -v stripe >/dev/null || { say "stripe CLI not found: card payments will not post"; return 0; }
  stop "$stripe_pid"
  stripe listen --api-key "$(envval STRIPE_SECRET_KEY)" \
    --events checkout.session.completed,checkout.session.async_payment_succeeded,charge.succeeded,charge.updated,charge.refunded,refund.created,refund.updated \
    --forward-to localhost:4000/webhooks/stripe >>"$STATE/stripe.log" 2>&1 &
  stripe_pid=$!
}

# The apps inline the brain URL at build time, and the phone agent calls it: both follow a new URL.
point_everything_at_url() {
  for _ in $(seq 1 20); do healthy "$url" && break; sleep 3; done
  if [[ "$(cat "$STATE/deployed-url" 2>/dev/null)" == "$url" ]]; then
    say "apps already use $url"
    return 0
  fi
  say "redeploying both apps (a few minutes)"
  if BRAIN_PUBLIC_URL="$url" scripts/deploy-web.sh both >>"$STATE/deploy.log" 2>&1; then
    echo "$url" >"$STATE/deployed-url"
    say "apps redeployed"
  else
    say "redeploy FAILED; see $STATE/deploy.log"
  fi
  if (cd services/brain && npx tsx --env-file-if-exists=../../.env scripts/cartesia-setup.ts "$url" "${CARTESIA_ARGS[@]}") >>"$STATE/cartesia.log" 2>&1; then
    say "phone agent re-pointed"
  else
    say "phone agent update FAILED; see $STATE/cartesia.log"
  fi
}

if lsof -nP -iTCP:4000 -sTCP:LISTEN >/dev/null 2>&1; then
  say "something already listens on :4000 (another brain?). Stop it first."
  exit 1
fi

until start_tunnel; do sleep 10; done
start_brain
start_stripe
point_everything_at_url
say "demo is up: https://napkin-store.vercel.app  (brain $url)"

fails=0
while true; do
  sleep "$CHECK_EVERY"
  alive "$stripe_pid" || { say "stripe listen exited; restarting"; start_stripe; }
  if ! alive "$brain_pid" || ! healthy http://localhost:4000; then
    say "brain is down; restarting"
    start_brain
    continue
  fi
  if alive "$tunnel_pid" && healthy "$url"; then
    fails=0
    continue
  fi
  fails=$((fails + 1))
  say "public /health failed ($fails/$FAILS_BEFORE_NEW_TUNNEL)"
  if ((fails >= FAILS_BEFORE_NEW_TUNNEL)); then
    say "tunnel is gone; opening a new one"
    until start_tunnel; do sleep 10; done
    start_brain
    point_everything_at_url
    fails=0
    say "recovered: brain $url"
  fi
done
