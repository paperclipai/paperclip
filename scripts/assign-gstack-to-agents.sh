#!/bin/bash
# assign-gstack-to-agents.sh
# Agrega ~/.claude/skills/gstack como customSkillsDirs a los agentes pertinentes
# de todas las empresas en Paperclip.
#
# Uso: bash scripts/assign-gstack-to-agents.sh
#
# Agentes target por rol (los que se benefician de gstack):
#   CTO, Tech Lead, Engineering Lead  → /plan-eng-review, /review, /cso, /autoplan
#   CEO, Product Owner                → /plan-ceo-review, /office-hours, /retro
#   Frontend, Fullstack Developer     → /browse, /qa, /design-review, /benchmark
#   QA Engineer                       → /qa, /qa-only, /browse, /canary
#   DevOps, SRE                       → /ship, /land-and-deploy, /canary
#   Security, Compliance Officer      → /cso, /careful, /freeze, /guard
#   Designer                          → /design-consultation, /design-review
#   Technical Writer, Documentation   → /document-release

set -euo pipefail

DB_HOST="127.0.0.1"
DB_PORT="54329"
DB_USER="paperclip"
DB_NAME="paperclip"
export PGPASSWORD="paperclip"

GSTACK_DIR="$HOME/.claude/skills/gstack"

# Verify gstack is installed
if [ ! -d "$GSTACK_DIR" ]; then
  echo "ERROR: gstack not found at $GSTACK_DIR"
  echo "Run: git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup"
  exit 1
fi

echo "=== Assigning gstack skills to Paperclip agents ==="
echo "gstack directory: $GSTACK_DIR"
echo ""

# Agent name patterns that should get gstack (case-insensitive ILIKE)
# These cover roles across ALL companies
AGENT_PATTERNS=(
  '%CTO%'
  '%CEO%'
  '%Tech Lead%'
  '%Engineering%'
  '%Frontend%'
  '%Fullstack%'
  '%Full Stack%'
  '%Full-Stack%'
  '%Backend%'
  '%QA%'
  '%Quality%'
  '%DevOps%'
  '%SRE%'
  '%Security%'
  '%Compliance%'
  '%CSO%'
  '%Designer%'
  '%Design%'
  '%Writer%'
  '%Documentation%'
  '%Product%'
  '%Architect%'
  '%Lead%'
  '%Developer%'
  '%Engineer%'
)

# Build the WHERE clause
WHERE_PARTS=""
for pattern in "${AGENT_PATTERNS[@]}"; do
  if [ -z "$WHERE_PARTS" ]; then
    WHERE_PARTS="name ILIKE '$pattern'"
  else
    WHERE_PARTS="$WHERE_PARTS OR name ILIKE '$pattern'"
  fi
done

# First, show which agents will be updated
echo "Agents that will receive gstack:"
echo "─────────────────────────────────────────────────────"
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
SELECT c.name AS company, a.name AS agent,
       a.adapter_config->>'model' AS model,
       a.adapter_config->'customSkillsDirs' AS current_custom_dirs
FROM agents a
JOIN companies c ON a.company_id = c.id
WHERE ($WHERE_PARTS)
ORDER BY c.name, a.name;
"

echo ""
read -p "Proceed with update? (y/N) " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# Update: merge gstack dir into existing customSkillsDirs (or create new array)
UPDATED=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "
UPDATE agents
SET adapter_config = CASE
  -- If customSkillsDirs already exists and is an array
  WHEN adapter_config ? 'customSkillsDirs'
       AND jsonb_typeof(adapter_config->'customSkillsDirs') = 'array'
       AND NOT adapter_config->'customSkillsDirs' @> '\"$GSTACK_DIR\"'::jsonb
  THEN jsonb_set(
    adapter_config,
    '{customSkillsDirs}',
    adapter_config->'customSkillsDirs' || '\"$GSTACK_DIR\"'::jsonb
  )
  -- If customSkillsDirs doesn't exist yet
  WHEN NOT adapter_config ? 'customSkillsDirs'
  THEN jsonb_set(
    adapter_config,
    '{customSkillsDirs}',
    '[\"$GSTACK_DIR\"]'::jsonb
  )
  -- Already has gstack, no change needed
  ELSE adapter_config
END
WHERE ($WHERE_PARTS)
  AND adapter_config->>'adapter' IN ('claude_local', 'cursor_local')
RETURNING name;
")

echo ""
echo "=== Updated agents ==="
echo "$UPDATED"
echo ""
echo "Done! Agents will pick up gstack skills on their next heartbeat run."
