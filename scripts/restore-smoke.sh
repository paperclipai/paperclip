#!/usr/bin/env bash
set -euo pipefail

# restore-smoke.sh — restore backup artifacts into a throwaway environment and
# assert the result is usable. This is the repeatable test behind
# docs/deploy/backup-restore.md: run it on a schedule, because an artifact
# nobody has restored is a guess.
#
# Usage:
#   scripts/restore-smoke.sh --db db-<ts>.sql.gz [--volume paperclip-<ts>.tar.gz]
#                            [--boot <paperclip image>]
#
# Options:
#   --db <file>          gzipped pg_dump artifact (required)
#   --volume <file>      gzipped tar of the data directory; enables the
#                        master-key and run-log checks, which are the two
#                        things a database-only restore loses silently
#   --image <ref>        postgres image, default postgres:17-alpine — match the
#                        major version the dump came from
#   --max-missing <n>    run-log refs allowed to be missing, default 0. Set it
#                        to the number the *source* deployment is known to
#                        lack (see restore-verify-logs.sh), never to whatever
#                        makes the check pass
#   --boot <ref>         after the artifact checks, start this Paperclip server
#                        image against the restored database and the extracted
#                        tree and require its health endpoint to report ok.
#                        Needs --volume. The clone runs on a Docker network
#                        with no route out, so its heartbeats, routines and
#                        connectors can reach nothing but the throwaway
#                        database. It then mints a throwaway agent API key
#                        in the restored database (never the source's), signs
#                        in with it, and requires the API to serve the
#                        company's agents and issues, one issue's comments,
#                        one finalized run's record and events, and its log,
#                        each matching the restored database — restore step
#                        6, done by the server rather than by hand
#   --max-torn <n>       unfinalized transcripts allowed to end mid-line,
#                        default 0. Same rule as --max-missing: the source's
#                        known count, measured with restore-verify-logs.sh
#                        against the live tree
#   --allow-unbound      the data-directory tar carries no .backup-generation
#                        marker (its producer does not write one), so nothing
#                        ties it to --db and in-flight transcripts cannot be
#                        bounded; accept that, and say so. Without it the
#                        marker must be the tar's first member and name the
#                        sha256 of --db
#   --boot-timeout <s>   seconds to wait for the booted server, default 300;
#                        migrations newer than the dump apply during this
#   --keep               leave the containers, network and extracted tree
#                        behind
#
# Needs docker and tar on the host, and node when --volume is given (it
# decrypts the restored secrets with the restored key); psql runs inside the
# container, so the host needs no PostgreSQL client. Exits non-zero on the
# first failure.

DB_ARTIFACT=""
VOLUME_ARTIFACT=""
PG_IMAGE="postgres:17-alpine"
MAX_MISSING=0
MAX_TORN=0
BOOT_IMAGE=""
BOOT_TIMEOUT=300
KEEP=0
ALLOW_UNBOUND=0

usage() {
  sed -n '3,54p' "$0" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --db)     [ $# -ge 2 ] || usage; DB_ARTIFACT="$2"; shift 2 ;;
    --volume) [ $# -ge 2 ] || usage; VOLUME_ARTIFACT="$2"; shift 2 ;;
    --image)  [ $# -ge 2 ] || usage; PG_IMAGE="$2"; shift 2 ;;
    --max-missing) [ $# -ge 2 ] || usage; MAX_MISSING="$2"; shift 2 ;;
    --max-torn) [ $# -ge 2 ] || usage; MAX_TORN="$2"; shift 2 ;;
    --boot)  [ $# -ge 2 ] || usage; BOOT_IMAGE="$2"; shift 2 ;;
    --boot-timeout) [ $# -ge 2 ] || usage; BOOT_TIMEOUT="$2"; shift 2 ;;
    --allow-unbound) ALLOW_UNBOUND=1; shift ;;
    --keep)   KEEP=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$DB_ARTIFACT" ] || usage
[ -f "$DB_ARTIFACT" ] || { echo "FAIL: no such file: $DB_ARTIFACT" >&2; exit 1; }
if [ -n "$VOLUME_ARTIFACT" ] && [ ! -f "$VOLUME_ARTIFACT" ]; then
  echo "FAIL: no such file: $VOLUME_ARTIFACT" >&2
  exit 1
fi
if [ -n "$BOOT_IMAGE" ] && [ -z "$VOLUME_ARTIFACT" ]; then
  echo "--boot needs --volume: the server cannot start without the data directory" >&2
  usage
fi
case "$BOOT_TIMEOUT" in
  ''|*[!0-9]*) echo "--boot-timeout must be a whole number of seconds" >&2; usage ;;
esac
case "$MAX_TORN" in
  ''|*[!0-9]*) echo "--max-torn needs a non-negative integer, got: $MAX_TORN" >&2; usage ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="restore-smoke-$$"
APP_CONTAINER="$CONTAINER-app"
NETWORK="$CONTAINER-net"
EXTRACT_DIR=""

# The trap's own status must not leak into the script's exit code: bash reports
# the EXIT trap's last command as the exit status of an otherwise successful
# script, so a `[ -n "$EXTRACT_DIR" ] && ...` that is false here would turn a
# passing database-only run into exit 1.
cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "--keep: container $CONTAINER${BOOT_IMAGE:+, container $APP_CONTAINER, network $NETWORK} and ${EXTRACT_DIR:-(no extract dir)} left in place"
    return 0
  fi
  docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  if [ -n "$EXTRACT_DIR" ]; then
    # The archive carries read-only directories (skill bundles are 0555), and
    # rm cannot unlink inside them until they are writable again.
    chmod -R u+w "$EXTRACT_DIR" 2>/dev/null || true
    rm -rf "$EXTRACT_DIR" "$EXTRACT_DIR.refs" "$EXTRACT_DIR.secrets"
  fi
  return 0
}
trap cleanup EXIT

step() { echo; echo "=== $* ==="; }

# 1. The artifacts are intact. A truncated gzip is the most common bad surprise
#    and it costs a second to rule out before spending minutes on a restore.
step "artifact integrity"
gzip -t "$DB_ARTIFACT"
echo "ok: $DB_ARTIFACT"
if [ -n "$VOLUME_ARTIFACT" ]; then
  gzip -t "$VOLUME_ARTIFACT"
  echo "ok: $VOLUME_ARTIFACT"
fi

# 2. A clean database. POSTGRES_USER=paperclip is what makes the dump's
#    `OWNER TO`/`GRANT` statements resolve, and it makes that role a superuser
#    so `CREATE EXTENSION` succeeds.
step "clean $PG_IMAGE"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=paperclip \
  -e POSTGRES_DB=paperclip \
  -e POSTGRES_PASSWORD=restore-smoke \
  "$PG_IMAGE" >/dev/null

# Poll over TCP, not the unix socket. The postgres entrypoint runs a temporary
# server during initdb that listens on the socket only, so a socket-based
# pg_isready reports ready, we start loading, and the real startup pulls the
# server out from under us.
ready=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" \
      psql -U paperclip -d paperclip -h 127.0.0.1 -Atqc 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: $PG_IMAGE never accepted a TCP connection. Container log:" >&2
  docker logs "$CONTAINER" 2>&1 | tail -20 >&2
  exit 1
fi
echo "accepting connections"

# 3. Load it. ON_ERROR_STOP=1 is not optional: without it psql reports errors,
#    carries on, and exits 0 with a partially populated database.
step "load $DB_ARTIFACT"
gunzip -c "$DB_ARTIFACT" | docker exec -i "$CONTAINER" \
  psql -U paperclip -d paperclip -v ON_ERROR_STOP=1 --quiet --no-psqlrc
echo "load ok"

# 4. The SQL checker. It raises, so ON_ERROR_STOP turns a failed check into a
#    non-zero exit here.
step "restore-verify.sql"
docker exec -i "$CONTAINER" \
  psql -U paperclip -d paperclip -v ON_ERROR_STOP=1 -f - < "$SCRIPT_DIR/restore-verify.sql"

if [ -z "$VOLUME_ARTIFACT" ]; then
  echo
  echo "RESTORE SMOKE PASSED (database only)"
  echo "No --volume given, so the master key and the run-log files were NOT"
  echo "checked. A restore that passes here can still be missing every"
  echo "transcript and every stored credential."
  exit 0
fi

# 5. The data directory. Extracting one level off is the easiest mistake in the
#    whole runbook, and it looks like success until something opens a file.
step "extract $VOLUME_ARTIFACT"
EXTRACT_DIR="$(mktemp -d)"
tar -xzf "$VOLUME_ARTIFACT" -C "$EXTRACT_DIR" --strip-components=1
echo "extracted to $EXTRACT_DIR"

# 6. The master key. The database holds secret values encrypted against it;
#    without the file every stored credential is undecryptable, and nothing in
#    the database can tell you that. Presence is not enough either: a valid
#    32-byte key from a different artifact set boots the server just as well
#    and fails only when an agent first uses a credential. So every
#    local_encrypted_v1 version in the restored database is decrypted with the
#    restored key. AES-256-GCM authenticates, so a wrong key cannot decrypt by
#    accident, and the plaintext's SHA-256 is compared with value_sha256 on
#    the row. No plaintext leaves the node process.
step "secrets master key"
keys=()
for key in "$EXTRACT_DIR"/instances/*/secrets/master.key; do
  [ -f "$key" ] || continue
  keys+=("$key")
  mode="$(stat -c '%a' "$key")"
  echo "found $key (mode $mode)"
  if [ "$mode" != "600" ]; then
    echo "FAIL: master key mode is $mode, expected 600" >&2
    exit 1
  fi
done
if [ "${#keys[@]}" -eq 0 ]; then
  echo "FAIL: no instances/*/secrets/master.key in the archive." >&2
  echo "      Every stored credential is undecryptable from this artifact set," >&2
  echo "      or the archive was extracted at the wrong level." >&2
  exit 1
fi

versions_file="$EXTRACT_DIR.secrets"
docker exec "$CONTAINER" psql -U paperclip -d paperclip -Atq --no-psqlrc -F "$(printf '\t')" -c \
  "select id, value_sha256, material::text from company_secret_versions
    where material->>'scheme' = 'local_encrypted_v1'" > "$versions_file"
version_count="$(docker exec "$CONTAINER" psql -U paperclip -d paperclip -Atq --no-psqlrc -c \
  "select count(*) from company_secret_versions where material->>'scheme' = 'local_encrypted_v1'")"
if [ "$version_count" -eq 0 ]; then
  echo "no local_encrypted secret versions in the dump: nothing depends on this key"
elif [ "${#keys[@]}" -ne 1 ]; then
  echo "FAIL: ${#keys[@]} master keys in the archive and $version_count encrypted versions;" >&2
  echo "      which key belongs to this database is a choice this script must not make." >&2
  exit 1
else
  command -v node >/dev/null 2>&1 || { echo "FAIL: node not found on PATH; it decrypts the secrets" >&2; exit 1; }
  node "$SCRIPT_DIR/restore-verify-secrets.mjs" "${keys[0]}" --expect "$version_count" < "$versions_file"
fi

# 7. The run logs the restored database points at. This is the one check that
#    needs both artifacts at once, and the one nothing else performs. Every
#    ref, not a sample: a sample makes the outcome a coin toss on a deployment
#    that has a few source-side dangling refs of its own. log_bytes and
#    log_sha256 are what the server recorded at finalize; the checker compares
#    the extracted file against them, so a transcript the tar captured
#    mid-write fails here instead of passing as "present". last_output_bytes
#    is the floor for a run still in flight at the dump, and the tar's
#    .backup-generation marker — its first member, held to --db's own sha256 —
#    proves the tar started after this dump and so holds every byte those
#    runs wrote before it.
step "run-log reachability and content (every ref, tolerance $MAX_MISSING missing, $MAX_TORN torn)"
#    The rows go to a file first and the checker is held to the database's
#    count: `docker exec` piped into a reader that falls behind has been
#    measured dropping rows with exit 0, and a short list passes.
refs_file="$EXTRACT_DIR.refs"
docker exec "$CONTAINER" psql -U paperclip -d paperclip -Atq --no-psqlrc -F "$(printf '\t')" -c \
  "select log_ref, created_at, log_bytes, log_sha256, last_output_bytes
     from heartbeat_runs
    where log_store = 'local_file' and log_ref is not null" > "$refs_file"
ref_count="$(docker exec "$CONTAINER" psql -U paperclip -d paperclip -Atq --no-psqlrc -c \
  "select count(*) from heartbeat_runs where log_store = 'local_file' and log_ref is not null")"
if [ "$ALLOW_UNBOUND" -eq 1 ]; then
  generation_args=(--allow-unbound)
else
  dump_sha="$(sha256sum "$DB_ARTIFACT")"
  generation_args=(--dump-sha256 "${dump_sha%% *}" --archive "$VOLUME_ARTIFACT")
fi
"$SCRIPT_DIR/restore-verify-logs.sh" "$EXTRACT_DIR" --max-missing "$MAX_MISSING" \
  --max-torn "$MAX_TORN" --expect "$ref_count" "${generation_args[@]}" < "$refs_file"

if [ -z "$BOOT_IMAGE" ]; then
  echo
  echo "RESTORE SMOKE PASSED (database + data directory)"
  echo "No --boot given, so no server was started against the result. The"
  echo "artifacts restore and agree with each other; whether a Paperclip of"
  echo "this version boots on them and serves the board was not checked."
  exit 0
fi

# 8. A server. Everything above is a statement about files and rows; this is
#    the one about a deployment: the image starts against the restored
#    database and tree, applies whatever migrations are newer than the dump,
#    brings the auth stack up, and answers. It runs on an --internal network:
#    the clone is a full copy of the source board, and its heartbeats,
#    routines and connectors would otherwise act on the world as the source.
#    Inside that network it can reach the throwaway database and nothing else.
step "boot $BOOT_IMAGE against the restored database and tree"

instance_dir=""
instance_count=0
for dir in "$EXTRACT_DIR"/instances/*/; do
  [ -d "$dir" ] || continue
  instance_count=$((instance_count + 1))
  instance_dir="$dir"
done
if [ "$instance_count" -ne 1 ]; then
  echo "FAIL: expected exactly one instances/<id> in the archive, found $instance_count" >&2
  exit 1
fi
instance_id="$(basename "$instance_dir")"

docker network create --internal "$NETWORK" >/dev/null
docker network connect "$NETWORK" "$CONTAINER"

# The tree is mounted as the container's PAPERCLIP_HOME, owned by the caller,
# so the image's entrypoint is told to run as the caller's uid/gid rather than
# chown the extract. DATABASE_URL points at the restored database and
# overrides whatever connection string the restored config.json carries — that
# one names the source's database. The auth secret is fresh: it signs browser
# sessions, and reusing the source's here would be the only way this run
# could mint credentials valid on the source.
auth_secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run -d --name "$APP_CONTAINER" --network "$NETWORK" \
  -v "$EXTRACT_DIR":/paperclip \
  -e PAPERCLIP_HOME=/paperclip \
  -e PAPERCLIP_INSTANCE_ID="$instance_id" \
  -e PAPERCLIP_CONFIG="/paperclip/instances/$instance_id/config.json" \
  -e DATABASE_URL="postgres://paperclip:restore-smoke@$CONTAINER:5432/paperclip" \
  -e BETTER_AUTH_SECRET="$auth_secret" \
  -e USER_UID="$(id -u)" -e USER_GID="$(id -g)" \
  "$BOOT_IMAGE" >/dev/null

# Probes run inside the app container with its own node: the host needs
# nothing beyond docker and tar, and the API key travels on stdin, never in a
# process list. Each probe prints one tab-separated line or fails with the
# HTTP status and body.
PROBE_JS='
const fs = require("node:fs");
const mode = process.env.PROBE;
const arg = process.env.PROBE_ARG || "";
const key = fs.readFileSync(0, "utf8").trim();
const headers = key ? { authorization: "Bearer " + key } : {};
async function get(path) {
  const res = await fetch("http://localhost:3100" + path, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error("HTTP " + res.status + " " + path + ": " + text.slice(0, 300));
  return JSON.parse(text);
}
(async () => {
  if (mode === "health") {
    const j = await get("/api/health");
    console.log(String(j.status) + "\t" + String(j.commit ?? ""));
  } else if (mode === "me") {
    const j = await get("/api/agents/me");
    console.log(j.id + "\t" + j.companyId + "\t" + j.name);
  } else if (mode === "company") {
    const [company, agents, issues] = await Promise.all([
      get("/api/companies/" + arg),
      get("/api/companies/" + arg + "/agents"),
      get("/api/companies/" + arg + "/issues"),
    ]);
    console.log(company.name + "\t" + agents.length + "\t" + issues.length);
  } else if (mode === "issue") {
    const [issue, comments] = await Promise.all([
      get("/api/issues/" + arg),
      get("/api/issues/" + arg + "/comments"),
    ]);
    console.log(issue.identifier + "\t" + comments.length);
  } else if (mode === "run") {
    const [run, events] = await Promise.all([
      get("/api/heartbeat-runs/" + arg),
      get("/api/heartbeat-runs/" + arg + "/events?limit=1000"),
    ]);
    console.log(run.id + "\t" + run.status + "\t" + events.length);
  } else if (mode === "log") {
    const j = await get("/api/heartbeat-runs/" + arg + "/log?offset=0&limitBytes=65536");
    const content = String(j.content ?? "");
    if (!content) throw new Error("the API returned an empty log for run " + arg);
    const first = JSON.parse(content.split("\n")[0]);
    console.log(Buffer.byteLength(content) + "\t" + (first.ts ?? "") + "\t" + (first.stream ?? ""));
  } else {
    throw new Error("unknown probe " + mode);
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
'
SMOKE_KEY=""
probe() {
  printf '%s' "$SMOKE_KEY" \
    | docker exec -i -e PROBE="$1" -e PROBE_ARG="${2:-}" "$APP_CONTAINER" node -e "$PROBE_JS"
}

health=""
for _ in $(seq 1 "$BOOT_TIMEOUT"); do
  if ! docker inspect -f '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null | grep -q true; then
    echo "FAIL: $APP_CONTAINER exited. Container log:" >&2
    docker logs "$APP_CONTAINER" 2>&1 | tail -40 >&2
    exit 1
  fi
  health="$(probe health 2>/dev/null || true)"
  case "$health" in
    ok*) break ;;
  esac
  sleep 1
done
case "$health" in
  ok*) ;;
  *)
    echo "FAIL: /api/health did not report ok within ${BOOT_TIMEOUT}s (last: '${health:-no answer}'). Container log:" >&2
    docker logs "$APP_CONTAINER" 2>&1 | tail -40 >&2
    exit 1
    ;;
esac
echo "health: ${health%%$'\t'*}, commit ${health#*$'\t'}"
echo "migrations: $(docker exec "$CONTAINER" psql -U paperclip -d paperclip -Atq --no-psqlrc -c \
  "select count(*) from drizzle.__drizzle_migrations") applied (the dump's, plus any the image is newer by)"

# 9. The board, through the server. The key is minted here, in the restored
#    database only: an agent that has a finalized local run log gets a fresh
#    random token whose SHA-256 goes into agent_api_keys, exactly as the
#    server stores its own keys, on behalf of an active user member of its
#    company (the server refuses agent keys with no responsible user). Nothing
#    valid on the source is created or used. Every surface is held to what
#    the restored database says it should serve, not to "the call returned":
#    the company's agents and issues are non-empty, one issue comes back with
#    exactly its comments, one of the agent's own finalized runs comes back
#    with its status and exactly its events, and its log is served by the
#    server that owns it — the file the digest check verified on disk, read
#    back the way the UI reads it.
step "sign in and read the board through the restored server"
smoke_agent="$(docker exec "$CONTAINER" psql -U paperclip -d paperclip -Atq --no-psqlrc -F "$(printf '\t')" -c \
  "select r.agent_id, a.company_id, r.id, m.principal_id, r.status, e.n
     from heartbeat_runs r
     join agents a on a.id = r.agent_id
     join lateral (
       select principal_id from company_memberships
        where company_id = a.company_id and principal_type = 'user' and status = 'active'
        order by (membership_role = 'owner') desc, created_at limit 1
     ) m on true
     join lateral (
       select count(*) as n from heartbeat_run_events where run_id = r.id
     ) e on e.n between 1 and 1000
    where r.log_store = 'local_file' and r.log_ref is not null
      and r.log_sha256 is not null and r.log_bytes > 0
      and a.status not in ('terminated', 'pending_approval')
    order by r.created_at desc limit 1")"
if [ -z "$smoke_agent" ]; then
  echo "FAIL: no active agent with a finalized local run log, 1-1000 run events and an active user in its company to sign in as" >&2
  exit 1
fi
agent_id="$(echo "$smoke_agent" | cut -f1)"
run_id="$(echo "$smoke_agent" | cut -f3)"
run_status="$(echo "$smoke_agent" | cut -f5)"
run_events="$(echo "$smoke_agent" | cut -f6)"
# The company's most recently commented issue: the one most likely to show a
# comment path broken by the restore, and certain to have comments to count.
smoke_issue="$(docker exec "$CONTAINER" psql -U paperclip -d paperclip -Atq --no-psqlrc -F "$(printf '\t')" -c \
  "select i.id, i.identifier, (select count(*) from issue_comments where issue_id = i.id)
     from issues i
     join issue_comments c on c.issue_id = i.id
    where i.company_id = '$(echo "$smoke_agent" | cut -f2)'
    order by c.created_at desc limit 1")"
if [ -z "$smoke_issue" ]; then
  echo "FAIL: the signed-in agent's company has no commented issue in the restored database" >&2
  exit 1
fi
SMOKE_KEY="restore-smoke-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf "insert into agent_api_keys (agent_id, company_id, name, key_hash, responsible_user_id)
  values ('%s', '%s', 'restore-smoke', encode(sha256(convert_to('%s', 'UTF8')), 'hex'), '%s');\n" \
  "$agent_id" "$(echo "$smoke_agent" | cut -f2)" "$SMOKE_KEY" "$(echo "$smoke_agent" | cut -f4)" \
  | docker exec -i "$CONTAINER" psql -U paperclip -d paperclip -q --no-psqlrc -v ON_ERROR_STOP=1 >/dev/null

me="$(probe me)"
agent_id="${me%%$'\t'*}"
rest="${me#*$'\t'}"
company_id="${rest%%$'\t'*}"
agent_name="${rest#*$'\t'}"
echo "signed in as agent '$agent_name' ($agent_id), company $company_id"

board="$(probe company "$company_id")"
company_name="$(echo "$board" | cut -f1)"
listed_agents="$(echo "$board" | cut -f2)"
listed_issues="$(echo "$board" | cut -f3)"
echo "company '$company_name': $listed_agents agents, $listed_issues issues listed"
if [ "$listed_agents" -eq 0 ] || [ "$listed_issues" -eq 0 ]; then
  echo "FAIL: the restored server lists $listed_agents agents and $listed_issues issues for a company the database has both for" >&2
  exit 1
fi

issue_id="$(echo "$smoke_issue" | cut -f1)"
want_identifier="$(echo "$smoke_issue" | cut -f2)"
want_comments="$(echo "$smoke_issue" | cut -f3)"
served_issue="$(probe issue "$issue_id")"
have_identifier="$(echo "$served_issue" | cut -f1)"
have_comments="$(echo "$served_issue" | cut -f2)"
echo "issue $have_identifier: $have_comments comments served, database has $want_comments"
if [ "$have_identifier" != "$want_identifier" ] || [ "$have_comments" -ne "$want_comments" ]; then
  echo "FAIL: issue $want_identifier came back as '$have_identifier' with $have_comments of $want_comments comments" >&2
  exit 1
fi

served_run="$(probe run "$run_id")"
have_status="$(echo "$served_run" | cut -f2)"
have_events="$(echo "$served_run" | cut -f3)"
echo "run $run_id: status $have_status, $have_events events served, database has $run_status and $run_events"
if [ "$(echo "$served_run" | cut -f1)" != "$run_id" ] || [ "$have_status" != "$run_status" ] \
    || [ "$have_events" -ne "$run_events" ]; then
  echo "FAIL: run $run_id did not come back as the database recorded it" >&2
  exit 1
fi

served="$(probe log "$run_id")"
echo "run $run_id: log served through the API, ${served%%$'\t'*} bytes read, first event at $(echo "$served" | cut -f2) on $(echo "$served" | cut -f3), NDJSON parses"

echo
echo "RESTORE SMOKE PASSED (database + data directory + server boots + board served)"
