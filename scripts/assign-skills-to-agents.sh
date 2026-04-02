#!/bin/bash
# assign-skills-to-agents.sh
# Assigns gstack + superpowers as customSkillsDirs to technical agents
# across ALL Paperclip companies.
#
# Technical agents (get gstack + superpowers):
#   CTO, Founding Engineer, Frontend Lead, Head of AI, AutoResearch
#
# All other agents use built-in skills only (from /skills/ directory).
#
# Usage: bash scripts/assign-skills-to-agents.sh

set -euo pipefail

DB_HOST="127.0.0.1"
DB_PORT="54329"
DB_USER="paperclip"
DB_NAME="paperclip"
export PGPASSWORD="paperclip"

GSTACK_DIR="$HOME/.claude/skills/gstack"
SUPERPOWERS_DIR="$HOME/.claude/skills/superpowers"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║    Paperclip Unified Skills Assignment                      ║"
echo "║    gstack + superpowers + built-in skills                   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Verify external skills are installed ───
MISSING=0

if [ ! -d "$GSTACK_DIR" ]; then
  echo "⚠  gstack not found at $GSTACK_DIR"
  echo "   Run: git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup"
  MISSING=1
fi

if [ ! -d "$SUPERPOWERS_DIR" ]; then
  echo "⚠  superpowers not found at $SUPERPOWERS_DIR"
  echo "   Run: git clone --single-branch --depth 1 https://github.com/obra/superpowers.git ~/.claude/skills/superpowers"
  MISSING=1
fi

if [ "$MISSING" -eq 1 ]; then
  echo ""
  read -p "Continue with available skills only? (y/N) " cont
  if [[ "$cont" != "y" && "$cont" != "Y" ]]; then
    echo "Install missing skills and retry."
    exit 1
  fi
fi

# ─── Step 2: Test DB connection ───
if ! psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" > /dev/null 2>&1; then
  echo "ERROR: Cannot connect to PostgreSQL at $DB_HOST:$DB_PORT"
  echo "Make sure Paperclip server is running."
  exit 1
fi

echo "✓ Database connected"
echo ""

# ─── Step 3: Build customSkillsDirs JSON array ───
DIRS_ARRAY="["
FIRST=1
if [ -d "$GSTACK_DIR" ]; then
  DIRS_ARRAY="${DIRS_ARRAY}\"$GSTACK_DIR\""
  FIRST=0
fi
if [ -d "$SUPERPOWERS_DIR" ]; then
  if [ "$FIRST" -eq 0 ]; then
    DIRS_ARRAY="${DIRS_ARRAY},"
  fi
  DIRS_ARRAY="${DIRS_ARRAY}\"$SUPERPOWERS_DIR\""
fi
DIRS_ARRAY="${DIRS_ARRAY}]"

echo "Skills directories to assign: $DIRS_ARRAY"
echo ""

# ─── Step 4: Show what will be updated ───
# Technical agents matched by exact name
TECH_WHERE="a.name IN ('CTO', 'Founding Engineer', 'Frontend Lead', 'Head of AI', 'AutoResearch')"

echo "Agents that WILL receive external skills (gstack + superpowers):"
echo "────────────────────────────────────────────────────────────────"
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
SELECT c.name AS company, a.name AS agent, a.adapter_type,
       a.adapter_config->>'model' AS model
FROM agents a
JOIN companies c ON a.company_id = c.id
WHERE $TECH_WHERE
ORDER BY c.name, a.name;
"

echo ""
echo "Agents that will use built-in skills ONLY:"
echo "────────────────────────────────────────────────────────────────"
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
SELECT c.name AS company, a.name AS agent, a.adapter_type
FROM agents a
JOIN companies c ON a.company_id = c.id
WHERE NOT ($TECH_WHERE)
ORDER BY c.name, a.name;
"

echo ""
read -p "Proceed with update? (y/N) " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# ─── Step 5: Apply updates ───
echo ""
echo "Updating technical agents..."

UPDATED=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "
UPDATE agents a
SET adapter_config = jsonb_set(
  COALESCE(a.adapter_config, '{}'::jsonb),
  '{customSkillsDirs}',
  '${DIRS_ARRAY}'::jsonb
)
WHERE $TECH_WHERE
  AND a.adapter_type IN ('claude_local', 'cursor_local')
RETURNING a.name;
")

echo "$UPDATED"

# Count
COUNT=$(echo "$UPDATED" | grep -c '[a-zA-Z]' || true)
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Updated $COUNT agents with external skills"
echo ""
echo "  Built-in skills (automatic for ALL 56 agents):"
echo "    unified-dev-workflow, dev-methodology, iterative-optimization,"
echo "    internet-research, finance-analysis, agent-security,"
echo "    paperclip-operations, autoresearch, embedding-autoresearch,"
echo "    multimodal-search, peer-review-response"
echo ""
echo "  External skills (technical agents only):"
if [ -d "$GSTACK_DIR" ]; then
  echo "    ✓ gstack: /review, /qa, /browse, /ship, /cso, /benchmark..."
fi
if [ -d "$SUPERPOWERS_DIR" ]; then
  echo "    ✓ superpowers: TDD, systematic-debugging, subagents, worktrees..."
fi
echo ""
echo "  Agents pick up changes on next heartbeat run."
echo "════════════════════════════════════════════════════════════════"
