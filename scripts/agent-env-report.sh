#!/bin/sh
set -eu

workspace_root="${1:-/workspace/voyage}"

print_header() {
  printf "== %s ==\n" "$1"
}

print_version() {
  tool="$1"
  version_flag="${2:---version}"
  if command -v "$tool" >/dev/null 2>&1; then
    version_output="$($tool "$version_flag" 2>/dev/null | head -n 1 || true)"
    if [ -n "$version_output" ]; then
      printf "%-10s %s\n" "$tool" "$version_output"
    else
      tool_path="$(command -v "$tool")"
      printf "%-10s available at %s\n" "$tool" "$tool_path"
    fi
  else
    printf "%-10s missing\n" "$tool"
  fi
}

print_path() {
  path="$1"
  if [ -e "$path" ]; then
    printf "%-28s present\n" "$path"
  else
    printf "%-28s missing\n" "$path"
  fi
}

print_header "Agent Environment"
printf "timestamp    %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf "user         %s\n" "$(id -un)"
printf "uid:gid      %s:%s\n" "$(id -u)" "$(id -g)"
printf "cwd          %s\n" "$(pwd)"
printf "home         %s\n" "${HOME:-<unset>}"
printf "shell        %s\n" "${SHELL:-<unset>}"
printf "arch         %s\n" "$(uname -m)"
printf "kernel       %s\n" "$(uname -sr)"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  printf "os           %s\n" "${PRETTY_NAME:-unknown}"
fi

print_header "Key Paths"
print_path /workspace
print_path "$workspace_root"
print_path /paperclip
print_path /paperclip/.ssh
print_path /app

print_header "Tool Versions"
print_version node
print_version npm
print_version pnpm
print_version git
print_version rg
print_version fd
print_version jq
print_version yq
print_version python
print_version python3
print_version uv
print_version codex version
print_version opencode version
print_version claude version

print_header "Workspace Snapshot"
if [ -d "$workspace_root" ]; then
  printf "workspace    %s\n" "$workspace_root"
  find "$workspace_root" -maxdepth 1 -mindepth 1 | sort | sed 's#^#- #'
else
  printf "workspace    missing\n"
fi
