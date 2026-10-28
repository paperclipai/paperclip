#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux ]]; then
  printf 'Linux ARM qualification preparation requires a GitHub Actions Linux runner.\n' >&2
  exit 1
fi

. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04
test "$(dpkg --print-architecture)" = arm64
test "$(uname -m)" = aarch64
prerequisite_report_dir=${RUNNER_TEMP:?}/paperclip-arm-bwrap-prerequisite
mkdir -p "$prerequisite_report_dir"
prerequisite_download_dir=$(mktemp -d "${RUNNER_TEMP}/paperclip-arm-stock-packages.XXXXXX")
before_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)
before_apparmor=$(cat /sys/module/apparmor/parameters/enabled)
before_clone=$(sysctl -n kernel.unprivileged_userns_clone)
test "$before_userns" = 1
test "$before_apparmor" = Y
test "$before_clone" = 1
printf 'restriction=%s apparmor=%s clone=%s\n' \
  "$before_userns" "$before_apparmor" "$before_clone" | \
  tee "$prerequisite_report_dir/before.txt"

parser=$(readlink -f "$(command -v apparmor_parser)")
test "$parser" = /usr/sbin/apparmor_parser
test "$(stat -c '%u' "$parser")" = 0
dpkg-query -W -f='${Package} ${Version} ${Architecture}\n' \
  apparmor libc6 libcap2 libselinux1 | \
  tee "$prerequisite_report_dir/existing-package-versions.txt"
dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libc6)" ge 2.38
dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libcap2)" ge 1:2.10
dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libselinux1)" ge 3.1~

timeout 120s sudo apt-get \
  -o Acquire::AllowInsecureRepositories=false \
  -o APT::Get::AllowUnauthenticated=false update | \
  tee "$prerequisite_report_dir/apt-update.txt"
apt-cache policy bubblewrap apparmor-profiles | \
  tee "$prerequisite_report_dir/apt-policy.txt"
for package_name in bubblewrap apparmor-profiles; do
  package_version=$(apt-cache policy "$package_name" | awk '/Candidate:/ {print $2}')
  test -n "$package_version"
  test "$package_version" != '(none)'
  apt-cache show "$package_name=$package_version" > \
    "$prerequisite_report_dir/$package_name-index.txt"
  package_sha256=$(awk '/^SHA256:/ {print $2}' \
    "$prerequisite_report_dir/$package_name-index.txt")
  test "${#package_sha256}" = 64
  printf '%s\n' "$package_sha256" | grep -E '^[0-9a-f]{64}$' >/dev/null
  (
    cd "$prerequisite_download_dir"
    timeout 60s apt-get -o APT::Get::AllowUnauthenticated=false \
      download "$package_name=$package_version"
  )
  package_files=("$prerequisite_download_dir"/"$package_name"_*.deb)
  test "${#package_files[@]}" = 1
  package_file=${package_files[0]}
  test -f "$package_file"
  printf '%s  %s\n' "$package_sha256" "$package_file" | sha256sum -c -
  test "$(dpkg-deb -f "$package_file" Package)" = "$package_name"
  test "$(dpkg-deb -f "$package_file" Version)" = "$package_version"
  dpkg-deb -f "$package_file" Package Version Architecture | \
    tee "$prerequisite_report_dir/$package_name-downloaded-version.txt"
  if test "$package_name" = bubblewrap; then
    test "$(dpkg-deb -f "$package_file" Architecture)" = arm64
    dpkg-deb --fsys-tarfile "$package_file" | \
      tar -xO ./usr/bin/bwrap > "$prerequisite_download_dir/bwrap"
  else
    test "$(dpkg-deb -f "$package_file" Architecture)" = all
    dpkg-deb --fsys-tarfile "$package_file" | \
      tar -xO ./usr/share/apparmor/extra-profiles/bwrap-userns-restrict > \
        "$prerequisite_download_dir/bwrap-userns-restrict"
  fi
done

stock_binary=$prerequisite_download_dir/bwrap
stock_profile=$prerequisite_download_dir/bwrap-userns-restrict
printf '11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9  %s\n' \
  "$stock_profile" | sha256sum -c -
cat "$stock_profile" | tee "$prerequisite_report_dir/stock-profile.txt"
test "$(od -An -tx1 -N4 "$stock_binary" | tr -d ' \n')" = 7f454c46
readelf -h "$stock_binary" | tee "$prerequisite_report_dir/bwrap-elf-header.txt"
grep -E 'Machine:.*AArch64' "$prerequisite_report_dir/bwrap-elf-header.txt"

test ! -L /usr/bin/bwrap
if test -e /usr/bin/bwrap; then
  test -f /usr/bin/bwrap
  cmp "$stock_binary" /usr/bin/bwrap
else
  sudo install -o root -g root -m 0755 "$stock_binary" /usr/bin/bwrap
fi
test "$(readlink -f "$(command -v bwrap)")" = /usr/bin/bwrap
test "$(stat -c '%u:%g:%a' /usr/bin/bwrap)" = 0:0:755
command -v getcap >/dev/null
test -z "$(getcap /usr/bin/bwrap)"
sha256sum "$stock_binary" /usr/bin/bwrap | \
  tee "$prerequisite_report_dir/bwrap-sha256.txt"
timeout 5s /usr/bin/bwrap --version | tee "$prerequisite_report_dir/bwrap-version.txt"
help=$(timeout 5s /usr/bin/bwrap --help)
printf '%s\n' "$help" > "$prerequisite_report_dir/bwrap-help.txt"
printf '%s\n' "$help" | grep -F -- --as-pid-1 >/dev/null
printf '%s\n' "$help" | grep -F -- --perms >/dev/null

target=/etc/apparmor.d/bwrap-userns-restrict
test ! -L "$target"
test ! -L /etc/apparmor.d/local/bwrap-userns-restrict
test ! -L /etc/apparmor.d/local/unpriv_bwrap
test ! -s /etc/apparmor.d/local/bwrap-userns-restrict
test ! -s /etc/apparmor.d/local/unpriv_bwrap
if test -e "$target"; then
  test -f "$target"
  cmp "$stock_profile" "$target"
else
  sudo install -o root -g root -m 0644 "$stock_profile" "$target"
fi
timeout 15s sudo "$parser" -r "$target"
sha256sum "$stock_profile" "$target" | \
  tee "$prerequisite_report_dir/profile-sha256.txt"
loaded_profiles=$(sudo cat /sys/kernel/security/apparmor/profiles)
for required_profile in 'bwrap (enforce)' 'unpriv_bwrap (enforce)'; do
  printf '%s\n' "$loaded_profiles" | grep -Fx "$required_profile" | \
    tee -a "$prerequisite_report_dir/loaded-profiles.txt"
done
after_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)
after_apparmor=$(cat /sys/module/apparmor/parameters/enabled)
after_clone=$(sysctl -n kernel.unprivileged_userns_clone)
test "$after_userns" = "$before_userns"
test "$after_apparmor" = "$before_apparmor"
test "$after_clone" = "$before_clone"
printf 'restriction=%s apparmor=%s clone=%s\n' \
  "$after_userns" "$after_apparmor" "$after_clone" | \
  tee "$prerequisite_report_dir/after.txt"
timeout 5s /usr/bin/bwrap --die-with-parent --unshare-user --unshare-net \
  --ro-bind / / --cap-drop ALL /bin/true
printf 'stock files materialized without dpkg registration or maintainer scripts; namespace probe passed; no provider processes or turns\n' | \
  tee "$prerequisite_report_dir/namespace-probe.txt"
