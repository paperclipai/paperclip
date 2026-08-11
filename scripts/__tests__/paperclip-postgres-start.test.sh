#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_SCRIPT="$SCRIPT_DIR/paperclip-postgres-start.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-postgres-start-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

make_fixture() {
  local name="$1" root
  root="$TEST_ROOT/$name"
  mkdir -p "$root/bin" "$root/data" "$root/logs"
  printf '18\n' > "$root/data/PG_VERSION"
  cp /usr/bin/true "$root/bin/initdb"
  cp /usr/bin/true "$root/bin/postgres"
  printf '%s\n' "$root"
}

run_launcher() {
  local root="$1"
  PAPERCLIP_SOURCE_ROOT="$root" \
  PAPERCLIP_POSTGRES_DATA_DIR="$root/data" \
  PAPERCLIP_POSTGRES_PORT=54329 \
  PAPERCLIP_EMBEDDED_POSTGRES_BIN_DIR="$root/bin" \
  PAPERCLIP_POSTGRES_LOG_DIR="$root/logs" \
    bash "$START_SCRIPT" 2>"$root/stderr"
}

dead_root="$(make_fixture dead-pid)"
printf '99999999\n%s\n0\n54329\n' "$dead_root/data" > "$dead_root/data/postmaster.pid"
run_launcher "$dead_root"
test ! -f "$dead_root/data/postmaster.pid"
grep -q 'removing stale postmaster marker' "$dead_root/stderr"

reused_root="$(make_fixture reused-pid)"
sleep 30 &
reused_pid=$!
printf '%s\n%s\n0\n54329\n' "$reused_pid" "$reused_root/data" > "$reused_root/data/postmaster.pid"
run_launcher "$reused_root"
kill "$reused_pid" 2>/dev/null || true
wait "$reused_pid" 2>/dev/null || true
test ! -f "$reused_root/data/postmaster.pid"
grep -q 'process identity/data-dir/port mismatch' "$reused_root/stderr"

expected_root="$(make_fixture expected-postgres)"
sleep 1 &
expected_pid=$!
printf '%s\n%s\n0\n54329\n' "$expected_pid" "$expected_root/data" > "$expected_root/data/postmaster.pid"
cat > "$expected_root/fake-ps" <<EOF
#!/usr/bin/env bash
last_arg=''
for arg in "\$@"; do last_arg="\$arg"; done
if [ "\$last_arg" = "comm=" ]; then
  printf '%s\n' '$expected_root/bin/postgres'
else
  printf '%s\n' '$expected_root/bin/postgres -D $expected_root/data -p 54329'
fi
EOF
chmod +x "$expected_root/fake-ps"
PAPERCLIP_POSTGRES_PS_COMMAND="$expected_root/fake-ps" run_launcher "$expected_root"
wait "$expected_pid" 2>/dev/null || true
test ! -f "$expected_root/data/postmaster.pid"
grep -q 'expected postmaster already running' "$expected_root/stderr"

echo 'paperclip-postgres-start tests PASS'
