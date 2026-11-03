#!/usr/bin/env bash
# E2E del ciclo EGM: dispara un run atado a un issue y verifica el ciclo entero.
#   bash egm-e2e.sh <issueId> [leadAgentId]
# Salida: auditoría del run + estado del issue (plan doc con veredicto + status).
set -uo pipefail
cd "$HOME" || exit 1
ISSUE="${1:?uso: egm-e2e.sh <issueId> [leadAgentId]}"
LEAD="${2:-a01b5e31-abf5-470e-8be2-661c555b8d67}"   # pi
CLI="$HOME/.paperclip/cli/current/node_modules/paperclipai/dist/index.js"
API="${PAPERCLIP_API_BASE:-http://100.82.79.91:3100}"
AUDIT="$HOME/egm-run-audit.sh"
ART="/home/paperclip/egm-artifacts/$ISSUE"

# 1. el agente tiene que estar despierto (idle), no paused
node "$CLI" agent resume "$LEAD" --api-base "$API" >/dev/null 2>&1
sleep 2

# 2. el comentario que despierta con la tarea atada
node "$CLI" issue comment "$ISSUE" --api-base "$API" --json >/dev/null 2>&1 \
  --body "Ciclo EGM: revisá el artefacto con el oro (task, sesiones nuevas, sólo lectura), escribí la síntesis y subila al documento plan con la línea EGM-VERDICT, y cerrá. El artefacto para el oro está en $ART y en el documento plan de este issue."

# 3. esperar el run y auditarlo
D="$HOME/.paperclip/instances/default/data/run-logs"
AGDIR="$D/$(node "$CLI" agent list -C 1e4f0704-f649-4c32-ba7d-19ce08084939 --api-base "$API" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const x=a.find(v=>v.id==="'"$LEAD"'");process.stdout.write(x?x.id:"")})')"
for i in $(seq 1 45); do
  N="$(ls -t "$AGDIR"/*.ndjson 2>/dev/null | head -1)"
  if [ -n "$N" ] && grep -q "lifecycle: run" "$N"; then
    echo "== auditoría del run =="; bash "$AUDIT" "$N" 2>/dev/null
    echo "== issue =="
    node "$CLI" issue get "$ISSUE" --api-base "$API" --json 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s).issue||JSON.parse(s);const b=String(i.planDocument?.body||i.planDocument?.latestBody||"");console.log("status="+i.status+" | plan="+(i.planDocument?b.length+"b":"no"));const m=/EGM-VERDICT\s*:\s*(.+)/.exec(b);console.log("veredicto:",m?m[1].trim():"(ninguno)")})'
    exit 0
  fi
  sleep 20
done
echo "el run no cerró en 15 min"; N="$(ls -t "$AGDIR"/*.ndjson 2>/dev/null | head -1)"; bash "$AUDIT" "$N" 2>/dev/null
