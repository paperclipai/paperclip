#!/bin/bash
# assign-skills-to-agents.sh
# Asigna skills unificadas (gstack + superpowers + MiniMax + finance + agent-reach)
# a los agentes pertinentes de TODAS las empresas en Paperclip.
#
# Skills built-in (automáticas para todos, desde /skills/):
#   unified-dev-workflow, dev-methodology, iterative-optimization,
#   internet-research, finance-analysis, agent-security,
#   paperclip-operations, autoresearch, embedding-autoresearch,
#   multimodal-search, peer-review-response
#
# Skills externas (via customSkillsDirs, selectivas por rol):
#   gstack      → CTO, Engineering, Frontend, QA, DevOps, Security, Design
#   superpowers → Todos los developers/engineers (TDD, planning, subagents)
#
# Uso: bash scripts/assign-skills-to-agents.sh

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

# ─── Step 3: Show current state ───
echo "Current agents and their customSkillsDirs:"
echo "────────────────────────────────────────────────────────────────"
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
SELECT c.name AS company, a.name AS agent,
       a.adapter_config->>'adapter' AS adapter,
       a.adapter_config->>'model' AS model,
       COALESCE(a.adapter_config->'customSkillsDirs'::text, '[]') AS custom_dirs
FROM agents a
JOIN companies c ON a.company_id = c.id
WHERE a.adapter_config->>'adapter' IN ('claude_local', 'cursor_local')
ORDER BY c.name, a.name;
"

echo ""

# ─── Step 4: Build customSkillsDirs arrays per role ───
# All technical roles get both gstack + superpowers
# Non-technical roles (CEO, CMO, Legal, etc.) get neither (they use built-in skills only)

# Build the JSON array of dirs to assign
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

# Technical agent patterns (get gstack + superpowers)
TECH_PATTERNS="
  name ILIKE '%CTO%'
  OR name ILIKE '%Tech Lead%'
  OR name ILIKE '%Engineering%'
  OR name ILIKE '%Frontend%'
  OR name ILIKE '%Fullstack%'
  OR name ILIKE '%Full Stack%'
  OR name ILIKE '%Full-Stack%'
  OR name ILIKE '%Backend%'
  OR name ILIKE '%QA%'
  OR name ILIKE '%Quality%'
  OR name ILIKE '%DevOps%'
  OR name ILIKE '%SRE%'
  OR name ILIKE '%Security%'
  OR name ILIKE '%Compliance%'
  OR name ILIKE '%Designer%'
  OR name ILIKE '%Design%'
  OR name ILIKE '%Architect%'
  OR name ILIKE '%Developer%'
  OR name ILIKE '%Engineer%'
  OR name ILIKE '%Lead%'
  OR name ILIKE '%Writer%'
  OR name ILIKE '%Documentation%'
  OR name ILIKE '%AutoResearch%'
  OR name ILIKE '%Research%'
"

echo "Agents that will receive external skills (gstack + superpowers):"
echo "────────────────────────────────────────────────────────────────"
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
SELECT c.name AS company, a.name AS agent, a.adapter_config->>'model' AS model
FROM agents a
JOIN companies c ON a.company_id = c.id
WHERE ($TECH_PATTERNS)
  AND a.adapter_config->>'adapter' IN ('claude_local', 'cursor_local')
ORDER BY c.name, a.name;
"

echo ""
echo "Agents that will use built-in skills ONLY (CEO, CMO, CFO, Legal, Sales, etc.):"
echo "────────────────────────────────────────────────────────────────"
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
SELECT c.name AS company, a.name AS agent, a.adapter_config->>'model' AS model
FROM agents a
JOIN companies c ON a.company_id = c.id
WHERE NOT ($TECH_PATTERNS)
  AND a.adapter_config->>'adapter' IN ('claude_local', 'cursor_local')
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
UPDATE agents
SET adapter_config = jsonb_set(
  adapter_config,
  '{customSkillsDirs}',
  '${DIRS_ARRAY}'::jsonb
)
WHERE ($TECH_PATTERNS)
  AND adapter_config->>'adapter' IN ('claude_local', 'cursor_local')
RETURNING name;
")

echo "$UPDATED"

# Count
COUNT=$(echo "$UPDATED" | grep -c '[a-zA-Z]' || true)
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Updated $COUNT agents with external skills"
echo ""
echo "  Built-in skills (automatic for ALL agents):"
echo "    - unified-dev-workflow    (gstack + superpowers combined)"
echo "    - dev-methodology         (TDD, debugging, git worktrees)"
echo "    - iterative-optimization  (structured iteration cycles)"
echo "    - internet-research       (web, YouTube, RSS access)"
echo "    - finance-analysis        (market data, sentiment, reports)"
echo "    - agent-security          (sandboxing, policies, credentials)"
echo "    - paperclip-operations    (Paperclip admin guide)"
echo "    - autoresearch            (Karpathy experiment loop)"
echo "    - embedding-autoresearch  (multimodal embeddings)"
echo "    - multimodal-search       (Gemini Embedding 2 RAG)"
echo "    - peer-review-response    (academic review patterns)"
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
