#!/usr/bin/env bash
set -euo pipefail

# prepare-server-skills.sh — Copy the repo-root skills/ directory into server/skills.
# server/src/routes/access.ts and server/src/services/company-skills.ts resolve
# built-in skills from <package-root>/skills in a published/packaged install
# (as opposed to repo-root/skills in dev mode), so this keeps that artifact
# self-contained for @paperclipai/server publish/bundle artifacts, mirroring
# prepare-server-ui-dist.sh.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"
SERVER_SKILLS="$REPO_ROOT/server/skills"

if [ ! -d "$SKILLS_SRC" ]; then
  echo "Error: skills source directory missing at $SKILLS_SRC"
  exit 1
fi

rm -rf "$SERVER_SKILLS"
cp -r "$SKILLS_SRC" "$SERVER_SKILLS"
echo "  -> Copied skills to server/skills"
