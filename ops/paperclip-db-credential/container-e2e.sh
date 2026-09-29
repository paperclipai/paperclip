#!/bin/bash
# Disposable synthetic proof. Never prints a connection string or password.
set -Eeuo pipefail
set +x
pgbin=/usr/lib/postgresql/16/bin
root=$(mktemp -d)
chmod 0755 "$root"
pgdata=$root/pgdata
socket=$root/socket
port=55433
assertions=0
cleanup() {
  runuser -u postgres -- "$pgbin/pg_ctl" -D "$pgdata" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT
trap 'printf "Synthetic e2e failed at line %s\n" "$LINENO" >&2' ERR
mkdir -m 0700 "$pgdata" "$socket"
chown postgres:postgres "$pgdata" "$socket"
touch "$root/postgres.log"
chown postgres:postgres "$root/postgres.log"
runuser -u postgres -- "$pgbin/initdb" -D "$pgdata" --auth-local=trust --auth-host=scram-sha-256 >/dev/null
runuser -u postgres -- "$pgbin/pg_ctl" -D "$pgdata" -o "-h 127.0.0.1 -k $socket -p $port" -l "$root/postgres.log" start >/dev/null
admin() { runuser -u postgres -- psql -h "$socket" -p "$port" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@" >/dev/null; }

admin -c 'CREATE DATABASE synthetic;'
admin -c 'REVOKE ALL ON DATABASE synthetic FROM PUBLIC;'
new_password() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
old_password=$(new_password)
service_password=$(new_password)
admin -c "CREATE ROLE old_agent LOGIN PASSWORD '$old_password'; GRANT CONNECT ON DATABASE synthetic TO old_agent;"
admin -c "CREATE ROLE pc_service LOGIN PASSWORD '$service_password'; GRANT CONNECT ON DATABASE synthetic TO pc_service;"
runuser -u postgres -- psql -h "$socket" -p "$port" -U postgres -d synthetic -X -q -v ON_ERROR_STOP=1 -c 'CREATE TABLE protected (id integer); GRANT USAGE ON SCHEMA public TO pc_service; GRANT SELECT ON protected TO pc_service;' >/dev/null

useradd -u 2101 -M -s /usr/sbin/nologin pc-service
useradd -u 2102 -M -s /usr/sbin/nologin pc-agent
mkdir -p "$root/credentials" "$root/worktree/.paperclip"
chmod 0755 "$root" "$root/credentials" "$root/worktree" "$root/worktree/.paperclip"
printf '{"database":{"mode":"postgres"}}\n' > "$root/worktree/.paperclip/config.json"
printf 'PAPERCLIP_INSTANCE_ID=synthetic\n' > "$root/worktree/.paperclip/.env"

make_credential() {
  local user=$1 role=$2 password=$3 directory=$4
  mkdir -m 0700 "$directory"
  printf 'postgres://%s:%s@127.0.0.1:%s/synthetic\n' "$role" "$password" "$port" > "$directory/database-url"
  chmod 0400 "$directory/database-url"
  chown -R "$user:$user" "$directory"
}
make_credential pc-service pc_service "$service_password" "$root/credentials/service"

# These fixtures are executable connection-source templates, not copies of the
# host business logic. The production scripts require a separate SQL audit.
mkdir -p /usr/local/libexec/paperclip/jobs
install -m 0755 /work/run-host-job /usr/local/libexec/paperclip/run-host-job
install -m 0755 /work/pg-client /usr/local/libexec/paperclip/pg-client
for fixture in /work/fixtures/jobs/*; do
  install -m 0644 "$fixture" /usr/local/libexec/paperclip/jobs/"${fixture##*/}"
done
admin -d synthetic -c '
  CREATE TABLE daily_records (id integer);
  CREATE TABLE fleet_records (id integer);
  CREATE TABLE watchdog_state (checked boolean);
  CREATE TABLE testdb_records (id integer);
  CREATE TABLE wipcap_state (checked boolean);
  CREATE TABLE disk_records (id integer);
  INSERT INTO daily_records VALUES (1);
  INSERT INTO fleet_records VALUES (1);
  INSERT INTO watchdog_state VALUES (false);
  INSERT INTO testdb_records VALUES (1);
  INSERT INTO wipcap_state VALUES (false);
  INSERT INTO disk_records VALUES (1);
'

jobs=(daily fleet watchdog testgc wipcap disk)
tables=(daily_records fleet_records watchdog_state testdb_records wipcap_state disk_records)
privileges=(SELECT SELECT UPDATE DELETE UPDATE SELECT)
for index in "${!jobs[@]}"; do
  job=${jobs[$index]}
  role=pc_job_$((index + 1))
  password=$(new_password)
  user=pcjob-$job
  useradd -u "$((2110 + index))" -M -s /usr/sbin/nologin "$user"
  admin -c "CREATE ROLE $role LOGIN PASSWORD '$password'; GRANT CONNECT ON DATABASE synthetic TO $role;"
  admin -d synthetic -c "GRANT USAGE ON SCHEMA public TO $role; GRANT ${privileges[$index]} ON ${tables[$index]} TO $role;"
  make_credential "$user" "$role" "$password" "$root/credentials/$job"
done

probe() {
  local user=$1 credential=$2 expected=$3
  runuser -u "$user" -- /work/probe-credential.sh "$credential" "$expected" >/dev/null
  assertions=$((assertions + 2))
}
probe pc-service "$root/credentials/service/database-url" pc_service
for index in "${!jobs[@]}"; do
  job=${jobs[$index]}
  probe "pcjob-$job" "$root/credentials/$job/database-url" "pc_job_$((index + 1))"
done

# Exercise every installed job entrypoint through the actual wrapper. Revoking
# its one required table privilege then makes the same job fail closed.
for index in "${!jobs[@]}"; do
  job=${jobs[$index]}
  credential_dir="$root/credentials/$job"
  if runuser -u "pcjob-$job" -- env -i PATH=/usr/local/bin:/usr/bin:/bin \
      CREDENTIALS_DIRECTORY="$credential_dir" \
      /usr/local/libexec/paperclip/run-host-job "$job" >"$root/job-output" 2>&1; then
    :
  else
    status=$?
    echo "Synthetic $job job failed with its granted role (exit $status)" >&2
    sed -E -e 's#postgres(ql)?://[^[:space:]]+#postgres://[REDACTED]#g' \
      -e 's/(PASSWORD|PGPASSWORD)=[^[:space:]]+/\1=[REDACTED]/g' "$root/job-output" | tail -8 >&2
    exit 1
  fi
  assertions=$((assertions + 1))
  admin -d synthetic -c "REVOKE ${privileges[$index]} ON ${tables[$index]} FROM pc_job_$((index + 1));"
  if runuser -u "pcjob-$job" -- env -i PATH=/usr/local/bin:/usr/bin:/bin \
      CREDENTIALS_DIRECTORY="$credential_dir" \
      /usr/local/libexec/paperclip/run-host-job "$job" >/dev/null 2>&1; then
    echo "Synthetic $job job retained access after grant revocation" >&2
    exit 1
  fi
  assertions=$((assertions + 1))
done

# A distinct agent UID cannot read any service/job credential, including
# through the worktree path.
for credential in "$root"/credentials/*/database-url; do
  runuser -u pc-agent -- test ! -r "$credential"
  assertions=$((assertions + 1))
done
printf 'postgres://old_agent:%s@127.0.0.1:%s/synthetic\n' "$old_password" "$port" > "$root/old-url"
chmod 0600 "$root/old-url"
cp "$root/old-url" "$root/old-url-agent-copy"
chmod 0644 "$root/old-url-agent-copy"
gate=/work/verify-old-url-revoked.py
if python3 "$gate" --old-url-file "$root/old-url" \
    --service-url-file "$root/credentials/service/database-url" > "$root/gate-result"; then
  echo 'Pre-dispatch gate allowed an active old DB role' >&2
  exit 1
fi
grep -q 'old DB URL still authenticates' "$root/gate-result"
assertions=$((assertions + 1))
runuser -u pc-agent -- /work/probe-credential.sh "$root/old-url-agent-copy" old_agent >/dev/null
assertions=$((assertions + 1))

# Only after the old jobs have been replaced may dispatch reopen. Model the
# revoke/rotation/session-termination order before testing the leaked old URL.
rotated_password=$(new_password)
admin -c "ALTER ROLE old_agent NOLOGIN; ALTER ROLE old_agent PASSWORD '$rotated_password';"
admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'old_agent' AND pid <> pg_backend_pid();"
if runuser -u pc-agent -- /work/probe-credential.sh "$root/old-url-agent-copy" old_agent >/dev/null 2>&1; then
  echo 'Old DB URL still connects after revocation' >&2
  exit 1
fi
assertions=$((assertions + 1))
python3 "$gate" --old-url-file "$root/old-url" \
  --service-url-file "$root/credentials/service/database-url" > "$root/gate-result"
grep -q '^PASS:' "$root/gate-result"
assertions=$((assertions + 1))
if grep -R -F "$old_password" "$root/worktree" >/dev/null; then exit 1; fi
assertions=$((assertions + 1))
echo "Synthetic DB identity assertions passed: $assertions"
