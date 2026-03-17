#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

dry_run=false
version=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/rollback-latest.sh <stable-version> [--dry-run]

Examples:
  ./scripts/rollback-latest.sh 2026.3.17
  ./scripts/rollback-latest.sh 2026.3.17 --dry-run

Notes:
  - This repoints the npm dist-tag "latest" for every public package.
  - It does not unpublish anything.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$version" ]; then
        echo "Error: only one version may be provided." >&2
        exit 1
      fi
      version="$1"
      ;;
  esac
  shift
done

if [ -z "$version" ]; then
  usage
  exit 1
fi

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be a stable calendar version like 2026.3.17." >&2
  exit 1
fi

if [ "$dry_run" = false ] && ! npm whoami >/dev/null 2>&1; then
  echo "Error: npm publish rights are required. Run 'npm login' first." >&2
  exit 1
fi

list_public_package_names() {
  node - "$REPO_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const roots = ['packages', 'server', 'ui', 'cli'];
const seen = new Set();

function walk(relDir) {
  const absDir = path.join(root, relDir);
  const pkgPath = path.join(absDir, 'package.json');

  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.private && !seen.has(pkg.name)) {
      seen.add(pkg.name);
      process.stdout.write(`${pkg.name}\n`);
    }
    return;
  }

  if (!fs.existsSync(absDir)) {
    return;
  }

  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    walk(path.join(relDir, entry.name));
  }
}

for (const rel of roots) {
  walk(rel);
}
NODE
}

package_names="$(list_public_package_names)"

if [ -z "$package_names" ]; then
  echo "Error: no public packages were found in the workspace." >&2
  exit 1
fi

while IFS= read -r package_name; do
  [ -z "$package_name" ] && continue
  if [ "$dry_run" = true ]; then
    echo "[dry-run] npm dist-tag add ${package_name}@${version} latest"
  else
    npm dist-tag add "${package_name}@${version}" latest
    echo "Updated latest -> ${package_name}@${version}"
  fi
done <<< "$package_names"
