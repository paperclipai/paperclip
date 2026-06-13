#!/usr/bin/env bash
# migrate-company.sh — interaktiivinen migraatio-helper.
# Kopioi cookie-cutter templatet (Dockerfile, docker-compose, deploy.yml, pr.yml)
# kohdereposta mv50000/cicd-templates-hakemistosta. EI committoi muutoksia.
#
# Usage:
#   bash scripts/migrate-company.sh <company-slug> [<stack: rust|node>]
#
# Example:
#   bash scripts/migrate-company.sh saatavilla node
#   bash scripts/migrate-company.sh quantimodo rust

set -euo pipefail

COMPANY="${1:?company slug required (e.g. saatavilla, quantimodo)}"
STACK="${2:-}"

REPO_DIR="/opt/repos/${COMPANY}"
if [ ! -d "$REPO_DIR/.git" ]; then
  REPO_DIR="${HOME}/${COMPANY}"
fi
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "ERROR: company repo not found at /opt/repos/${COMPANY} or ~/${COMPANY}" >&2
  exit 1
fi

# Auto-detect stack if not given
if [ -z "$STACK" ]; then
  if [ -f "$REPO_DIR/Cargo.toml" ]; then
    STACK="rust"
  elif [ -f "$REPO_DIR/package.json" ]; then
    STACK="node"
  else
    echo "Cannot auto-detect stack; specify rust or node explicitly" >&2
    exit 1
  fi
  echo "==> Auto-detected stack: $STACK"
fi

if [[ "$STACK" != "rust" && "$STACK" != "node" ]]; then
  echo "ERROR: stack must be 'rust' or 'node' (got: $STACK)" >&2
  exit 1
fi

# Pin to a specific commit SHA, not the mutable `v1` tag, so a force-push
# or compromise of the upstream tag cannot silently inject altered templates
# (Dockerfile, compose, workflow) into migrated company repos. To uplift,
# bump CICD_REF to a newer SHA after auditing changes upstream.
CICD_REF="${CICD_REF:-fec95b4553396b9acdb29c25da1c09ac1df76ea0}"  # mv50000/cicd v1 @ 2026-04-25
CICD_BASE="https://raw.githubusercontent.com/mv50000/cicd/${CICD_REF}"

echo "==> Migrating ${COMPANY} (${STACK}) at ${REPO_DIR}"
cd "$REPO_DIR"

fetch() {
  local url="$1"
  local target="$2"
  if [ -f "$target" ]; then
    echo "  ! $target already exists; saving as $target.new for diff"
    target="$target.new"
  fi
  mkdir -p "$(dirname "$target")"
  curl -fsSL "$url" -o "$target"
  echo "  + $target"
}

# 1. Dockerfile
fetch "$CICD_BASE/templates/dockerfiles/Dockerfile.${STACK}" "Dockerfile"

# 2. .dockerignore
cat > .dockerignore.new <<'EOF'
node_modules
target
.git
.github
.env
.env.local
*.log
.next
dist
build
EOF
if [ -f .dockerignore ]; then
  echo "  ! .dockerignore exists; new written as .dockerignore.new"
else
  mv .dockerignore.new .dockerignore
  echo "  + .dockerignore"
fi

# 3. deploy/docker-compose.yml
mkdir -p deploy
fetch "$CICD_BASE/templates/compose/docker-compose.yml" "deploy/docker-compose.yml"
sed -i "s/COMPANY/${COMPANY}/g" "deploy/docker-compose.yml" 2>/dev/null || \
  sed -i "s/COMPANY/${COMPANY}/g" "deploy/docker-compose.yml.new" 2>/dev/null || true

# 4. deploy/.env.example
cat > deploy/.env.example <<EOF
# Server-side env vars for ${COMPANY}.
# Copy to /srv/${COMPANY}/<env>/.env on the deploy host and fill in.
# IMAGE_TAG is rewritten by the deploy action; do not set manually.
IMAGE_TAG=
EOF
echo "  + deploy/.env.example"

# 5. .github/workflows/deploy.yml
mkdir -p .github/workflows
fetch "$CICD_BASE/templates/workflows/deploy.yml" ".github/workflows/deploy.yml"
sed -i "s/COMPANY/${COMPANY}/g" ".github/workflows/deploy.yml" 2>/dev/null || \
  sed -i "s/COMPANY/${COMPANY}/g" ".github/workflows/deploy.yml.new" 2>/dev/null || true

# 6. .github/workflows/pr.yml
fetch "$CICD_BASE/templates/workflows/pr.yml" ".github/workflows/pr.yml"

echo ""
echo "==> Done. Next steps:"
echo "    1. Review the staged files (git status, git diff). Files ending .new"
echo "       indicate a conflict with an existing file — merge manually."
echo "    2. Adapt Dockerfile to project-specific build steps."
echo "    3. Update deploy/docker-compose.yml ports/volumes for the company's needs."
echo "    4. Set DEPLOY_SSH_KEY secret on the repo (gh secret set DEPLOY_SSH_KEY)."
echo "    5. Bootstrap deploy host: ssh <host> 'sudo bash <(curl -L $CICD_BASE/scripts/server-bootstrap.sh) ${COMPANY} prod'"
echo "    6. Commit, push, watch: gh run watch"
echo ""
echo "Pinned to mv50000/cicd@${CICD_REF}. Override with CICD_REF env var to test newer commits."
