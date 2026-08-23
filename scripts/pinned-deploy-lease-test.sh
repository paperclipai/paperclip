#!/usr/bin/env bash
# Exercises the TSMC-21353 lease-safety changes in an ISOLATED state dir.
# Never touches ~/.paperclip/deploy or the live deploy pointer.
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pinned-deploy-promote.sh"
T=$(mktemp -d /private/tmp/lease-test-XXXXX)
export PAPERCLIP_PINNED_DEPLOY_STATE_DIR="$T/state"
export PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR="$T/receipts"
export PAPERCLIP_PINNED_DEPLOY_LEASE_DIR="$T/state/deployment-lease"
export PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT="$T/candidate"
LEASE="$PAPERCLIP_PINNED_DEPLOY_LEASE_DIR"
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (got '$2' want '$3')"; fail=$((fail+1)); fi; }

echo "== 1. a failing prepare-candidate must NOT leave the lease behind =="
export PAPERCLIP_PINNED_DEPLOY_LEASE_TOKEN="tok-A"
OUT=$("$S" prepare-candidate deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 2>&1); RC=$?
chk "prepare-candidate refused a bogus SHA" "$RC" "1"
echo "$OUT" | grep -q "released deployment lease after a failed run" \
  && { echo "  PASS  it announced the release"; pass=$((pass+1)); } \
  || { echo "  FAIL  no release message"; fail=$((fail+1)); }
[ -d "$LEASE" ] && { echo "  FAIL  lease dir survived a failed run"; fail=$((fail+1)); } \
                || { echo "  PASS  lease dir cleared"; pass=$((pass+1)); }

echo "== 2. a NEXT deploy is not wedged by that failure =="
export PAPERCLIP_PINNED_DEPLOY_LEASE_TOKEN="tok-B"
OUT=$("$S" prepare-candidate deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 2>&1)
echo "$OUT" | grep -q "already held\|held by a LIVE deploy" \
  && { echo "  FAIL  second run still refused as held"; fail=$((fail+1)); } \
  || { echo "  PASS  second run proceeded to its own error, not a lease refusal"; pass=$((pass+1)); }

echo "== 3. an ABANDONED lease (dead pid) is reclaimed =="
mkdir -p "$LEASE"
printf '{"token":"tok-OLD","actor":"ghost","acquiredAt":"2026-08-23T07:00:00Z","pid":999999}\n' > "$LEASE/owner.json"
export PAPERCLIP_PINNED_DEPLOY_LEASE_TOKEN="tok-C"
OUT=$("$S" prepare-candidate deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 2>&1)
echo "$OUT" | grep -q "reclaiming abandoned deployment lease: holder pid 999999" \
  && { echo "  PASS  reclaimed and named the dead holder"; pass=$((pass+1)); } \
  || { echo "  FAIL  did not reclaim"; fail=$((fail+1)); }

echo "== 4. a LIVE holder is REFUSED (never stomp a running promote) =="
sleep 400 & LIVEPID=$!
mkdir -p "$LEASE"
printf '{"token":"tok-OLD","actor":"realdeploy","acquiredAt":"2026-08-23T07:00:00Z","pid":%d}\n' "$LIVEPID" > "$LEASE/owner.json"
export PAPERCLIP_PINNED_DEPLOY_LEASE_TOKEN="tok-D"
OUT=$("$S" prepare-candidate deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 2>&1); RC=$?
chk "refused while the holder is alive" "$RC" "1"
echo "$OUT" | grep -q "held by a LIVE deploy: pid $LIVEPID (realdeploy)" \
  && { echo "  PASS  refusal names the live holder and how to clear"; pass=$((pass+1)); } \
  || { echo "  FAIL  refusal message unhelpful: $(echo "$OUT" | tail -1)"; fail=$((fail+1)); }
[ -f "$LEASE/owner.json" ] && { echo "  PASS  live lease left intact"; pass=$((pass+1)); } \
                           || { echo "  FAIL  live lease was destroyed"; fail=$((fail+1)); }
kill $LIVEPID 2>/dev/null

rm -rf "$T"
echo; echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
