/** Provider packs can move and their launchers can be invoked through task-local links. */
export function portableProviderShim(entrypoint, { node = false } = {}) {
  return [
    "#!/bin/sh",
    "set -eu",
    'self=$0; links=0',
    'while [ -L "$self" ]; do',
    '  links=$((links + 1)); [ "$links" -le 40 ] || exit 1',
    '  parent=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd)',
    '  self=$(readlink -- "$self")',
    '  case "$self" in /*) ;; *) self=$parent/$self ;; esac',
    'done',
    'basedir=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd)',
    `exec ${node ? '"$basedir/../node/bin/node" ' : ""}"$basedir/../${entrypoint}" "$@"`,
    "",
  ].join("\n");
}
