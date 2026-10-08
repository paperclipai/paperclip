#!/usr/bin/bash
# Stage reviewed cron code and systemd units. Run on the live host only after
# explicit founder go. This does not enable timers or move/revoke credentials.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

check_only=false
if [[ ${1:-} == --check ]]; then
  check_only=true
else
  [[ ${EUID} -eq 0 ]] || { echo 'root required' >&2; exit 1; }
  [[ ${HELA12871_FOUNDER_GO:-} == 1 ]] || { echo 'founder go required' >&2; exit 1; }
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ $check_only == false ]]; then
  # Never execute root staging logic out of an agent-writable worktree.
  [[ $source_dir == /opt/paperclip-cron-release/*/ops/cron-service ]] \
    || { echo 'use a root-owned checkout under /opt/paperclip-cron-release' >&2; exit 1; }
  python3 "$source_dir/board-watchers/verify_boundary.py" "$source_dir" \
    "$(git -C "$source_dir" rev-parse --absolute-git-dir)" /opt /etc/systemd/system /var/lib
  [[ -n ${HELA12871_APPROVED_SHA:-} ]] \
    && [[ $(git -C "$source_dir" rev-parse HEAD) == "$HELA12871_APPROVED_SHA" ]] \
    && [[ -z $(git -C "$source_dir" status --porcelain) ]] \
    || { echo 'reviewed commit SHA and clean checkout required' >&2; exit 1; }
  for env_file in /etc/paperclip-cron/watchdog.env /etc/paperclip-cron/quota.env; do
    if [[ -e $env_file ]] && /usr/bin/grep -Eq '^(WATCHDOG_PG|QR_PG|PAPERCLIP_OPS_TOKEN)=' "$env_file"; then
      echo 'legacy DB/ops credential in service env; remove before staging' >&2
      exit 1
    fi
  done
fi
host_home=/home/paperclip-user
if [[ $check_only == true ]]; then
  stage_base=${PAPERCLIP_RUN_SCRATCH_DIR:-/var/tmp}
else
  stage_base=/var/tmp
fi
stage=$(mktemp -d "$stage_base/hela12871-cron.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT

# Fail closed if any live host script changed since the reviewed patch was made.
printf '%s  %s\n' \
  '7d4f2ae5f79705e739c96d77ffd19f5b285e46bced6135ae7a86e94f91c03853' "$host_home/agent-watchdog.py" \
  'd68ea4697690608114844f1748738c8fdf700a6bd8387aec8c2c4562f58f93eb' "$host_home/quota-rewake/quota_rewake.py" \
  | sha256sum --check --status || { echo 'host sources changed; refresh review' >&2; exit 1; }

cp -- "$host_home/agent-watchdog.py" "$stage/agent-watchdog.py"
cp -- "$host_home/quota-rewake/quota_rewake.py" "$stage/quota_rewake.py"

# Check the exact bytes copied for patching as well as the live paths above:
# an agent-writable source can otherwise change between verification and cp.
printf '%s  %s\n' \
  '7d4f2ae5f79705e739c96d77ffd19f5b285e46bced6135ae7a86e94f91c03853' "$stage/agent-watchdog.py" \
  'd68ea4697690608114844f1748738c8fdf700a6bd8387aec8c2c4562f58f93eb' "$stage/quota_rewake.py" \
  | sha256sum --check --status || { echo 'copied host sources changed; refresh review' >&2; exit 1; }

# The old scripts contain a DB password literal. Remove it before applying the
# reviewed patches; no secret value enters this repository or patch output.
python3 - "$stage" <<'PY'
from pathlib import Path
import re
import sys
stage = Path(sys.argv[1])
for filename, variable, replacement in (
    ('agent-watchdog.py', 'DSN', "DSN = os.environ['WATCHDOG_PG']"),
    ('quota_rewake.py', 'CONN', "CONN = os.environ['QR_PG']"),
):
    path = stage / filename
    text, count = re.subn(rf'^{variable} = .+$', replacement, path.read_text(), count=1, flags=re.M)
    if count != 1:
        raise SystemExit(f'{filename}: DB config anchor changed')
    path.write_text(text)
PY

patch --batch --fuzz=0 -d "$stage" -p0 < "$source_dir/agent-watchdog.patch"
patch --batch --fuzz=0 -d "$stage" -p0 < "$source_dir/quota_rewake.patch"
python3 "$source_dir/sanitize-staged.py" "$stage"
python3 - "$stage" <<'PY'
import ast
from pathlib import Path
import sys
stage = Path(sys.argv[1])
for path in (stage / 'agent-watchdog.py', stage / 'quota_rewake.py'):
    ast.parse(path.read_text(), filename=str(path))
PY

if [[ $check_only == true ]]; then
  echo 'Host sources match reviewed hashes; sanitized patches and syntax checks pass.'
  exit 0
fi

for account in pc-cron-watchdog pc-cron-quota; do
  getent group "$account" >/dev/null || groupadd --system "$account"
  if ! id "$account" >/dev/null 2>&1; then
    useradd --system --gid "$account" --home-dir "/var/lib/$account" \
      --create-home --shell /usr/sbin/nologin "$account"
  fi
  install -d -o "$account" -g "$account" -m 0700 "/var/lib/$account"
done
install -d -o pc-cron-watchdog -g pc-cron-watchdog -m 0700 /var/lib/pc-cron-watchdog/.secrets
install -d -o pc-cron-quota -g pc-cron-quota -m 0700 /var/lib/pc-cron-quota/.secrets
install -d -o pc-cron-quota -g pc-cron-quota -m 0700 /var/lib/pc-cron-quota/quota-rewake
install -d -o root -g root -m 0755 /opt/paperclip-cron
install -d -o root -g root -m 0755 /etc/paperclip-cron
install -o root -g root -m 0755 "$stage/agent-watchdog.py" /opt/paperclip-cron/agent-watchdog.py
install -o root -g root -m 0755 "$stage/quota_rewake.py" /opt/paperclip-cron/quota_rewake.py
install -o root -g root -m 0644 "$source_dir"/*.service "$source_dir"/*.timer /etc/systemd/system/
systemctl daemon-reload
python3 "$source_dir/board-watchers/verify_boundary.py" /opt/paperclip-cron \
  /opt/paperclip-cron/agent-watchdog.py /opt/paperclip-cron/quota_rewake.py \
  /etc/systemd/system/paperclip-cron-watchdog.service \
  /etc/systemd/system/paperclip-cron-quota.service
echo 'Code and units staged. Timers remain disabled; create scoped identities/secrets, run smoke, then cut over.'
