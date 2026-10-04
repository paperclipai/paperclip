#!/usr/bin/bash
# HELA-13399: stage seven-flow host boundary; this script only installs new
# code/units after a separate founder go. It never provisions keys or cuts over.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

mode=${1:---check}
[[ $mode == --check || $mode == --install ]] || { echo 'usage: prepare-host.sh --check|--install' >&2; exit 2; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
host_home=/home/paperclip-user

# The reviewed sources are pinned even though the installed copies live in the
# immutable release checkout. A removed watcher cannot be silently revived.
printf '%s  %s\n' \
  'c81f3a35d0c1f77c984aa153b351ec6c2dcd26278872613153505ad63691e210' "$host_home/bin/disk-pressure-gc.sh" \
  '89ed0e612784703acefc66fa6cf23ccd435db091c6c25148dc5769cc14b53dc2' "$host_home/bin/closed-card-gc/disk_guard.py" \
  '241bf02c3ffa24ee20862c5bcbcdd682b10d20163ffaf712d43d8b20c011efde' "$host_home/bin/disk-guard-urgent.sh" \
  '17119fdc958a06c4d8b6c7b1ad616f2faff6ef3f106d9afbfa9108e83c45bc05' "$host_home/hela-12320-pr923-watch.py" \
  '0127f3bc082806bf65778d85423bdf121e8e157b621f1812c3854aec5a233d32' "$host_home/helloprint/qa-12359/watch-archive/hela-12359-r2-pr-watch.py" \
  'fd98b853a4d040522c9ce6e6e32e8aa25e09be293949c3d727f24422fe75bfc9' "$host_home/fleet-hourly-watch.py" \
  | sha256sum --check --status || { echo 'host source drift; review before cutover' >&2; exit 1; }
[[ ! -e "$host_home/hela-12359-r2-pr-watch.py" && ! -L "$host_home/hela-12359-r2-pr-watch.py" ]] \
  || { echo 'PR #1042 watcher reappeared; review its trigger' >&2; exit 1; }
[[ ! -e "$host_home/hela-12340-postmerge-watch.py" && ! -L "$host_home/hela-12340-postmerge-watch.py" ]] \
  || { echo 'PR #1198 watcher reappeared; review its trigger' >&2; exit 1; }

python3 - "$source_dir" <<'PY'
import ast
from pathlib import Path
import sys
source = Path(sys.argv[1])
for path in source.glob('*.py'):
    ast.parse(path.read_text(), filename=str(path))
PY
bash -n "$source_dir/disk-pressure-gc-agent.sh" "$host_home/bin/disk-guard-urgent.sh"
python3 "$source_dir/verify_boundary.py" /usr/bin/bash /usr/bin/python3 /usr/bin/psql

if [[ $mode == --check ]]; then
  echo 'Six reviewed source hashes match; retired PR #1198/#1042 paths remain absent; Python/shell/path checks pass.'
  exit 0
fi

[[ ${EUID} -eq 0 && ${HELA13399_FOUNDER_GO:-} == 1 ]] \
  || { echo 'root and founder go required for install' >&2; exit 1; }
[[ $source_dir == /opt/paperclip-cron-release/*/ops/cron-service/board-watchers ]] \
  || { echo 'use an isolated root-owned release checkout' >&2; exit 1; }
[[ -n ${HELA13399_APPROVED_SHA:-} ]] \
  && [[ $(git -C "$source_dir" rev-parse HEAD) == "$HELA13399_APPROVED_SHA" ]] \
  && [[ -z $(git -C "$source_dir" status --porcelain) ]] \
  || { echo 'clean approved commit required' >&2; exit 1; }
python3 "$source_dir/verify_boundary.py" "$source_dir" "$source_dir/prepare-host.sh" \
  "$(git -C "$source_dir" rev-parse --absolute-git-dir)" /opt /etc/systemd/system /var/lib
for env_file in /etc/paperclip-cron/pc-{disk-guard,watch-12320,watch-12340,watch-12359,fleet-watch}.env; do
  if [[ -e $env_file ]] && /usr/bin/grep -Eq '^(PAPERCLIP_OPS_TOKEN|PAPERCLIP_BRIDGE_TOKEN|WATCHDOG_PG|QR_PG)=' "$env_file"; then
    echo 'legacy credential in service env; remove before staging' >&2
    exit 1
  fi
done

for account in pc-disk-guard pc-watch-12320 pc-watch-12340 pc-watch-12359 pc-fleet-watch; do
  getent group "$account" >/dev/null || groupadd --system "$account"
  if ! id "$account" >/dev/null 2>&1; then
    useradd --system --gid "$account" --home-dir "/var/lib/$account" \
      --create-home --shell /usr/sbin/nologin "$account"
  fi
  install -d -o "$account" -g "$account" -m 0700 "/var/lib/$account"
  install -d -o "$account" -g "$account" -m 0700 "/var/lib/$account/.secrets"
done
install -d -o root -g root -m 0755 /opt/paperclip-cron /etc/paperclip-cron
for asset in service_http.py github_api.py pr923.py pr1198.py pr1042.py fleet.py \
    disk_reporter.py disk_client.py disk_guard_agent.py; do
  install -o root -g root -m 0755 "$source_dir/$asset" "/opt/paperclip-cron/$asset"
done
install -o root -g root -m 0755 "$source_dir/disk-pressure-gc-agent.sh" /opt/paperclip-cron/disk-pressure-gc-agent.sh
install -o root -g root -m 0644 "$source_dir"/*.service "$source_dir"/*.timer "$source_dir"/*.socket /etc/systemd/system/
systemctl daemon-reload
python3 "$source_dir/verify_boundary.py" /opt/paperclip-cron \
  /opt/paperclip-cron/*.py /opt/paperclip-cron/disk-pressure-gc-agent.sh \
  /etc/systemd/system/pc-disk-guard.service /etc/systemd/system/pc-disk-guard.socket \
  /etc/systemd/system/pc-watch-*.service /etc/systemd/system/pc-watch-*.timer \
  /etc/systemd/system/pc-fleet-watch.service /etc/systemd/system/pc-fleet-watch.timer
echo 'Code and units staged. No service, timer, socket, cron entry or credential was activated.'
