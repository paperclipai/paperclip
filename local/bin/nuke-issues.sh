#!/usr/bin/env bash
#
# Hard-delete a range of issues directly via PostgreSQL, bypassing the API.
#
# Use this when foreign-key constraints prevent API deletion. Deletes all
# dependent rows in the correct order before removing the issues themselves.
#
# Usage:
#   ./nuke-issues.sh <PREFIX> <START> <END>
#
# Example:
#   ./nuke-issues.sh LINAA 199 214
#
# Deletes issues LINAA-199 through LINAA-214 inclusive.
#
set -euo pipefail

cd "$(dirname "$0")/../.."

PREFIX="${1:-}"
START="${2:-}"
END="${3:-}"

if [[ -z "$PREFIX" || -z "$START" || -z "$END" ]]; then
  echo "usage: $(basename "$0") <PREFIX> <START> <END>" >&2
  echo "  e.g. $(basename "$0") LINAA 199 214" >&2
  exit 1
fi

if ! [[ "$START" =~ ^[0-9]+$ && "$END" =~ ^[0-9]+$ ]]; then
  echo "START and END must be integers" >&2
  exit 1
fi

if (( START > END )); then
  echo "START must be <= END" >&2
  exit 1
fi

PROJECT="paperclip-linkcast"
COMPOSE_FILES=(-f docker/docker-compose.yml)
if [[ -f local/compose/paperclip-boot-linkcast.yaml ]]; then
  COMPOSE_FILES+=(-f local/compose/paperclip-boot-linkcast.yaml)
fi

PSQL=(docker compose -p "$PROJECT" "${COMPOSE_FILES[@]}" exec -T db
  psql -U paperclip -d paperclip -v ON_ERROR_STOP=1)

# Build a SQL array literal for the identifier range, e.g. 'LINAA-199','LINAA-200',...
IDENTIFIERS=""
for (( i=START; i<=END; i++ )); do
  [[ -n "$IDENTIFIERS" ]] && IDENTIFIERS+=","
  IDENTIFIERS+="'${PREFIX}-${i}'"
done

COUNT=$(( END - START + 1 ))
echo "Nuking $COUNT issues: ${PREFIX}-${START} → ${PREFIX}-${END}"
echo "Project: $PROJECT"
echo

read -r -p "Confirm? This cannot be undone. [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

echo
echo "Resolving issue UUIDs..."
"${PSQL[@]}" <<EOF
-- Resolve identifiers to UUIDs once; everything below uses the id list.
CREATE TEMP TABLE _nuke_ids AS
  SELECT id FROM issues WHERE identifier IN ($IDENTIFIERS);

DO \$\$
DECLARE
  found_count INT;
BEGIN
  SELECT COUNT(*) INTO found_count FROM _nuke_ids;
  RAISE NOTICE 'Found % issue(s) to delete', found_count;
END \$\$;

-- Break self-referential FK: child issues pointing to issues in range
UPDATE issues SET parent_id = NULL WHERE parent_id IN (SELECT id FROM _nuke_ids);

-- Null FK references in tables where onDelete is not cascade/set-null
-- (financial records are nulled rather than deleted to preserve audit trail)
UPDATE cost_events    SET issue_id = NULL WHERE issue_id IN (SELECT id FROM _nuke_ids);
UPDATE finance_events SET issue_id = NULL WHERE issue_id IN (SELECT id FROM _nuke_ids);

-- Delete blocking child rows in dependency order
DELETE FROM issue_thread_interactions WHERE issue_id IN (SELECT id FROM _nuke_ids);
DELETE FROM issue_read_states         WHERE issue_id IN (SELECT id FROM _nuke_ids);
DELETE FROM issue_inbox_archives      WHERE issue_id IN (SELECT id FROM _nuke_ids);
DELETE FROM feedback_votes            WHERE issue_id IN (SELECT id FROM _nuke_ids);
DELETE FROM issue_comments            WHERE issue_id IN (SELECT id FROM _nuke_ids);

-- Delete the issues; cascade handles the rest
DELETE FROM issues WHERE id IN (SELECT id FROM _nuke_ids);

DROP TABLE _nuke_ids;
EOF

echo
echo "✓ Done."
