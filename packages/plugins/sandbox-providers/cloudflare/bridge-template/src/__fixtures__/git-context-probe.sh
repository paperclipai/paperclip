printf '\0PAPERCLIP_GIT_CONTEXT_V1\0'
if [ "$1" = host ]; then
  for key in GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN PAPERCLIP_GIT_TOKEN GH_CONFIG_DIR GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM GIT_CONFIG_COUNT GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_ASKPASS SSH_ASKPASS SSH_AUTH_SOCK GIT_SSH_COMMAND GIT_SSH; do
    eval 'value=${'"$key"'-}'
    [ -z "$value" ] || printf '%s\0%s\0' "$key" "$value"
  done
  index=0
  while [ "$index" -lt 32 ]; do
    for prefix in GIT_CONFIG_KEY_ GIT_CONFIG_VALUE_; do
      key="$prefix$index"
      eval 'value=${'"$key"'-}'
      [ -z "$value" ] || printf '%s\0%s\0' "$key" "$value"
    done
    index=$((index + 1))
  done
  printf 'PAPERCLIP_GITHUB_HOST_HOME\0%s\0' "$HOME"
  printf 'GH_CONFIG_DIR\0%s\0' "${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}"
fi
for file in /etc/resolv.conf /etc/hosts /etc/nsswitch.conf /etc/ssl/certs /etc/ssl/cert.pem; do
  index=0
  while [ -L "$file" ] && [ "$index" -lt 40 ]; do
    target=$(readlink "$file") || break
    case "$target" in /*) file="$target" ;; *) file="$(dirname "$file")/$target" ;; esac
    index=$((index + 1))
  done
  if [ -e "$file" ]; then
    parent=$(cd "$(dirname "$file")" && pwd -P) || continue
    printf 'PAPERCLIP_RUNNER_NETWORK_ROOT\0%s\0' "$parent/$(basename "$file")"
  fi
done
cwd=$(pwd -P)
top=$(git rev-parse --show-toplevel 2>/dev/null) || top=
if [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$cwd" ]; then
  for kind in --git-common-dir --git-dir; do
    root=$(git rev-parse --path-format=absolute "$kind" 2>/dev/null) || continue
    root=$(cd "$root" && pwd -P) || continue
    printf 'PAPERCLIP_GIT_METADATA_ROOT\0%s\0' "$root"
  done
fi
printf '\0PAPERCLIP_GIT_CONTEXT_END\0'
