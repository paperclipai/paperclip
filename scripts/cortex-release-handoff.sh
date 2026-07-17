#!/usr/bin/env bash
# cortex-release-handoff.sh — pre-primed out-of-band recovery handoff artifact for a canary cut.
#
# NEO-532 (subtask 522f of NEO-522, the Cortex CI/CD weekly-release pipeline). This is the
# "pre-primed handoff" half of Brian's out-of-band recovery requirement (NEO-522 plan §2.3):
#
#   request approval w/ version change log → approval → DROP an update-specific agent handoff
#   context (change summary + issue-tracing guidance) for an out-of-band agent → trigger the
#   §5 canary upgrade → verify.
#
# The weekly train (522d/NEO-529) calls `materialize` to write a self-contained HANDOFF.md +
# machine-readable context.env to a STABLE HOST PATH *before* it makes any live change, so the
# artifact is readable even with the live orchestrator down. If a canary update fails and the
# deterministic auto-rollback cannot restore green, the out-of-band recovery agent
# (scripts/cortex-oob-recover.sh, 522f) is pointed at this artifact — it has everything it needs
# to diagnose + restore without reaching back into the instance it is recovering.
#
# --- Why a host path outside the DB the orchestrator serves ------------------------------------
# The whole point of the handoff is that it survives the orchestrator being down. So it lives at
# CORTEX_RELEASE_ROOT (default /var/lib/cortex-release/<cut>/), NOT in the live tree, NOT in the
# Paperclip DB, NOT anything served by paperclip.service. A `latest` symlink always points at the
# most recently materialized cut so the recovery entrypoint can find it with zero arguments.
#
# Usage:
#   cortex-release-handoff.sh materialize <candidate-sha> [lkg-ref] [cut-id]
#       Write the handoff artifact for a promotion of <candidate-sha>. lkg-ref defaults to the
#       current live HEAD; cut-id defaults to the short candidate SHA. Prints the handoff dir.
#   cortex-release-handoff.sh changelog   <candidate-sha> [lkg-ref]
#       Print the version change log (issues + migrations + probes) for the cut. No writes.
#   cortex-release-handoff.sh record-backup <cut-id> <backup-path>
#       Append the concrete pre-promotion DB backup path to an already-materialized handoff.
#   cortex-release-handoff.sh path [cut-id]
#       Print the handoff dir for <cut-id> (or the `latest` symlink). No writes.
#
# Exit: 0 ok; 1 error (e.g. candidate not resolvable, root not writable).

set -euo pipefail

# --- Config (env-overridable) -----------------------------------------------------------------
# The stable host path — deliberately outside every instance tree + DB, so the artifact outlives
# the orchestrator it describes.
CORTEX_RELEASE_ROOT="${CORTEX_RELEASE_ROOT:-/var/lib/cortex-release}"

# The cut is sourced from beta (the snapshot origin) — it has both the candidate and the live LKG
# in its history, so the changelog range resolves there.
CORTEX_BETA_TREE="${CORTEX_BETA_TREE:-/home/ubuntu/projects/cortex-beta}"

# Live orchestrator coordinates — recorded verbatim into the handoff so the recovery agent's
# restore commands target the right tree/service/health endpoint. Mirror the train's defaults.
CORTEX_LIVE_TREE="${CORTEX_LIVE_TREE:-/home/ubuntu/projects/paperclip}"
CORTEX_LIVE_SERVICE="${CORTEX_LIVE_SERVICE:-paperclip.service}"
CORTEX_LIVE_HEALTH_URL="${CORTEX_LIVE_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
CORTEX_LIVE_BASE_URL="${CORTEX_LIVE_BASE_URL:-${CORTEX_LIVE_HEALTH_URL%/api/health}}"
CORTEX_LIVE_CONFIG="${CORTEX_LIVE_CONFIG:-}"
CORTEX_LIVE_REMOTE="${CORTEX_LIVE_REMOTE:-origin}"

# Where migrations live in-tree (for the "what schema changes are in this cut" section).
CORTEX_MIGRATIONS_DIR="${CORTEX_MIGRATIONS_DIR:-packages/db/src/migrations}"

log()  { printf '\033[1;36m[handoff]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[handoff] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[handoff] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- Changelog building -----------------------------------------------------------------------
# Resolve the last-known-good ref: caller-supplied, else the current live HEAD.
resolve_lkg() {
  local lkg="${1:-}"
  if [[ -z "$lkg" ]]; then
    lkg="$(git -C "$CORTEX_LIVE_TREE" rev-parse HEAD 2>/dev/null || true)"
  fi
  printf '%s' "$lkg"
}

# The list of commits carried by this cut (LKG..candidate), resolved in the beta tree which has
# both refs. Falls back gracefully if the range can't be computed (e.g. divergent histories).
commits_in_cut() {
  local lkg="$1" candidate="$2"
  if [[ -n "$lkg" ]] && git -C "$CORTEX_BETA_TREE" cat-file -e "${lkg}^{commit}" 2>/dev/null \
     && git -C "$CORTEX_BETA_TREE" cat-file -e "${candidate}^{commit}" 2>/dev/null; then
    git -C "$CORTEX_BETA_TREE" log --no-merges --pretty='- %h %s' "${lkg}..${candidate}" 2>/dev/null && return 0
  fi
  # No usable range → show the candidate tip alone rather than nothing.
  git -C "$CORTEX_BETA_TREE" log -1 --pretty='- %h %s' "$candidate" 2>/dev/null || true
}

# Added migrations (schema changes) in the cut — the highest-risk part of any promotion, because
# code rollback does NOT undo an applied migration (this is exactly what the recovery agent must
# reason about). diff-filter=A = files added in the range.
migrations_in_cut() {
  local lkg="$1" candidate="$2"
  [[ -n "$lkg" ]] || { echo "(unknown range — inspect $CORTEX_MIGRATIONS_DIR manually)"; return 0; }
  local out
  out="$(git -C "$CORTEX_BETA_TREE" diff --name-only --diff-filter=A "${lkg}..${candidate}" \
        -- "$CORTEX_MIGRATIONS_DIR" 2>/dev/null | sed 's#.*/##' | sed 's/^/- /' || true)"
  if [[ -z "$out" ]]; then echo "- (none — no new migrations in this cut; code-only rollback is sufficient)"; else printf '%s\n' "$out"; fi
}

# Per-issue content probes present in the cut. Probe file basenames ARE the issue ids (522b
# convention), which is what powers the per-change tracing table.
probes_in_repo() {
  local f found=0
  for f in "$CORTEX_BETA_TREE"/release-probes/*.yaml "$CORTEX_BETA_TREE"/release-probes/*.yml; do
    [[ -e "$f" ]] || continue
    found=1
    printf '- `%s` → probe file `release-probes/%s`\n' "$(basename "$f" | sed 's/\.[^.]*$//')" "$(basename "$f")"
  done
  [[ "$found" == 1 ]] || echo "- (no release-probes/*.yaml present — content-verify is a no-op for this cut)"
}

changelog() {
  local candidate="$1" lkg; lkg="$(resolve_lkg "${2:-}")"
  cat <<EOF
### Version change log — cut ${candidate:0:12}

- **Candidate (promote to):** \`${candidate}\`
- **Last-known-good (rollback to):** \`${lkg:-<unknown — live HEAD unresolved>}\`
- **Live target:** ${CORTEX_LIVE_SERVICE} @ ${CORTEX_LIVE_HEALTH_URL} (tree ${CORTEX_LIVE_TREE})

**Issues / commits in this cut (${lkg:0:12}..${candidate:0:12}):**
$(commits_in_cut "$lkg" "$candidate")

**Migrations added in this cut (schema changes — code rollback does NOT undo these):**
$(migrations_in_cut "$lkg" "$candidate")

**Per-issue content probes that must pass to call the cut green:**
$(probes_in_repo)
EOF
}

# --- Handoff materialization ------------------------------------------------------------------
cut_id_for() { local candidate="$1" cut="${2:-}"; [[ -n "$cut" ]] && { printf '%s' "$cut"; return; }; printf '%s' "${candidate:0:12}"; }

write_handoff() {
  local candidate="$1" lkg cut dir
  lkg="$(resolve_lkg "${2:-}")"
  cut="$(cut_id_for "$candidate" "${3:-}")"
  [[ -n "$candidate" ]] || die "materialize: candidate SHA is required"
  dir="$CORTEX_RELEASE_ROOT/$cut"

  mkdir -p "$dir" 2>/dev/null || die "cannot create handoff dir $dir (is $CORTEX_RELEASE_ROOT writable by $(id -un)?)"

  local created; created="$(now_iso)"

  # Machine-readable sidecar — sourced by the OOB recovery entrypoint. Keep keys stable.
  cat >"$dir/context.env" <<EOF
# cortex-release handoff context — cut $cut (materialized $created). Sourced by cortex-oob-recover.sh.
CORTEX_HANDOFF_CUT='$cut'
CORTEX_HANDOFF_CANDIDATE='$candidate'
CORTEX_HANDOFF_LKG='$lkg'
CORTEX_HANDOFF_LIVE_TREE='$CORTEX_LIVE_TREE'
CORTEX_HANDOFF_LIVE_SERVICE='$CORTEX_LIVE_SERVICE'
CORTEX_HANDOFF_LIVE_HEALTH_URL='$CORTEX_LIVE_HEALTH_URL'
CORTEX_HANDOFF_LIVE_BASE_URL='$CORTEX_LIVE_BASE_URL'
CORTEX_HANDOFF_LIVE_CONFIG='$CORTEX_LIVE_CONFIG'
CORTEX_HANDOFF_LIVE_REMOTE='$CORTEX_LIVE_REMOTE'
CORTEX_HANDOFF_BETA_TREE='$CORTEX_BETA_TREE'
CORTEX_HANDOFF_BACKUP=''
CORTEX_HANDOFF_CREATED='$created'
EOF

  # Human/agent-readable runbook. This is what a pre-primed Claude Code agent is pointed at.
  cat >"$dir/HANDOFF.md" <<EOF
# OOB recovery handoff — canary cut \`$cut\`

> Pre-primed by \`scripts/cortex-release-handoff.sh\` (NEO-532 / 522f) **before** any live change,
> at $created. Stable host path: \`$dir\` (outside the live tree + DB, readable with the
> orchestrator down). You are the **out-of-band recovery agent**: the deterministic auto-rollback
> in the weekly train (522d/522b) has ALREADY been tried and did not restore green — your job is
> to diagnose the novel failure and restore canary to a verified-green state using ONLY this
> artifact + host tools. Everything you need is below; you do not need to reach into the instance
> you are recovering.

$(changelog "$candidate" "$lkg")

## 1. Restore to last-known-good (the fast path — try this first)

The safest recovery is to put the live orchestrator back on the last-known-good ref \`$lkg\` and
prove it green. The out-of-band entrypoint does exactly this deterministically:

\`\`\`sh
# From the controller host (NOT a Paperclip heartbeat on the instance being recovered):
$CORTEX_BETA_TREE/scripts/cortex-oob-recover.sh --restore --handoff '$dir'
\`\`\`

Equivalent manual §5 steps if you must run them by hand:

\`\`\`sh
git -C '$CORTEX_LIVE_TREE' checkout --force '$lkg'
( cd '$CORTEX_LIVE_TREE'; unset NODE_ENV; pnpm install --frozen-lockfile && pnpm build )
sudo systemctl restart '$CORTEX_LIVE_SERVICE'
curl -fsS '$CORTEX_LIVE_HEALTH_URL'            # must return 200
\`\`\`

## 2. Database restore (only if the failed promotion applied a migration)

Code rollback alone does **not** undo an applied migration. If §"Migrations added" above is
non-empty and the failure was after migrate, restore the pre-promotion DB backup per
DEV-PROCESS §5.4 / the NEO-198 runbook. There is **no** \`db:restore\` CLI — restore is the
governed manual procedure:

\`\`\`sh
# Pre-promotion backup for this cut (filled in by the train right after it ran db:backup):
#   see CORTEX_HANDOFF_BACKUP in $dir/context.env  (—if empty, list backups:)
( cd '$CORTEX_LIVE_TREE'; npx paperclipai db:backup --list )   # find the newest pre-promotion file
sudo systemctl stop '$CORTEX_LIVE_SERVICE'
# ...restore that backup file into the live embedded Postgres per NEO-198...
git -C '$CORTEX_LIVE_TREE' checkout --force '$lkg'
sudo systemctl start '$CORTEX_LIVE_SERVICE'
\`\`\`

Never take a fresh \`db:backup\` *over* the pre-promotion one before restoring — you would lose
the known-good snapshot. Always \`db:backup\` **first** on any new forward attempt (Hard Rule #1).

## 3. Confirm recovery is green (health + content probes + smoke)

\`\`\`sh
curl -fsS '$CORTEX_LIVE_HEALTH_URL'
${CORTEX_LIVE_CONFIG:+PAPERCLIP_CONFIG='$CORTEX_LIVE_CONFIG' }node '$CORTEX_BETA_TREE/scripts/verify-content.mjs' \\
    --base '$CORTEX_LIVE_BASE_URL' --dir '$CORTEX_BETA_TREE/release-probes'
\`\`\`

Recovery is complete only when health returns 200 **and** every per-issue probe passes (exit 0).

## 4. Per-change tracing — which symptom maps to which change

Each probe file is named for its issue. If a probe is RED, that issue's change is the prime
suspect; open its release-probe to see the exact bundle string / route / DB assertion expected,
then trace from there:

$(probes_in_repo)

- A **route/health** failure with no probe red usually means the process failed to boot → check
  \`journalctl -u $CORTEX_LIVE_SERVICE -n 200\`; most often a build or migrate error → rollback (§1).
- A **db** probe red after a green boot means a migration applied but data/shape is wrong →
  DB restore may be required (§2).
- A **bundle** probe red means the UI build shipped without the expected change → rebuild from
  the candidate, or rollback if the candidate itself is bad (§1).

## 5. Escalation path

1. Deterministic restore to LKG (§1) — \`cortex-oob-recover.sh --restore\`.
2. If restore does not come green, this is a novel failure: diagnose from §4 + \`journalctl\`,
   and if a migration is implicated, DB restore (§2).
3. If live cannot be brought green at all, page the CTO (Werner) and hold: do NOT re-attempt the
   forward promotion. The approval token is single-use and already consumed; a new cut needs a
   fresh CTO approval.

_Audit: every recovery action taken via \`cortex-oob-recover.sh\` is logged to its audit log and
journald. This artifact + that log are the record of what happened._
EOF

  # `latest` symlink → this cut, so the recovery entrypoint finds it with no arguments.
  ln -sfn "$dir" "$CORTEX_RELEASE_ROOT/latest" 2>/dev/null || warn "could not update latest symlink"

  log "handoff materialized: $dir (cut $cut, candidate ${candidate:0:12}, lkg ${lkg:0:12})"
  printf '%s\n' "$dir"
}

# Append the concrete pre-promotion DB backup path once the train has actually taken it (called
# right after db:backup, still before the real promotion). Idempotent-ish: rewrites the key.
record_backup() {
  local cut="$1" backup="$2" dir
  dir="$CORTEX_RELEASE_ROOT/$cut"
  [[ -d "$dir" ]] || die "record-backup: no materialized handoff at $dir"
  [[ -f "$dir/context.env" ]] || die "record-backup: $dir/context.env missing"
  # Replace the CORTEX_HANDOFF_BACKUP line in the sidecar.
  local tmp="$dir/.context.env.tmp"
  awk -v b="$backup" '/^CORTEX_HANDOFF_BACKUP=/{print "CORTEX_HANDOFF_BACKUP=\x27" b "\x27"; next} {print}' \
    "$dir/context.env" >"$tmp" && mv "$tmp" "$dir/context.env"
  printf '\n> Pre-promotion DB backup (for §2 restore): `%s`\n' "$backup" >>"$dir/HANDOFF.md"
  log "recorded pre-promotion backup for cut $cut: $backup"
}

handoff_path() {
  local cut="${1:-}"
  if [[ -z "$cut" ]]; then printf '%s\n' "$CORTEX_RELEASE_ROOT/latest"; else printf '%s\n' "$CORTEX_RELEASE_ROOT/$cut"; fi
}

# When sourced by tests (CORTEX_HANDOFF_SOURCE_ONLY=1), expose the functions without dispatching.
[[ "${CORTEX_HANDOFF_SOURCE_ONLY:-}" == "1" ]] && return 0 2>/dev/null || true

# --- CLI --------------------------------------------------------------------------------------
cmd="${1:-}"; shift || true
case "$cmd" in
  materialize)   write_handoff "$@" ;;
  changelog)     changelog "$@" ;;
  record-backup) record_backup "$@" ;;
  path)          handoff_path "$@" ;;
  -h|--help|"")  grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "unknown command: $cmd (materialize|changelog|record-backup|path)" ;;
esac
