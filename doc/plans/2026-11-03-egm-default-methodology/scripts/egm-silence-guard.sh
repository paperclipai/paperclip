#!/bin/bash
# Guardia de silencio + auditoría de corridas.
# 1) Si el run más reciente de un agente lleva THRESHOLD sin output, se pausa al
#    agente. Importante: se mira SOLO el log más reciente por agente. Un log viejo
#    (de un run ya muerto, que nunca escribió 'lifecycle') no es un run colgado:
#    pausar por él mataba el run vivo que estaba corriendo (bug corregido).
# 2) Audita cada corrida que se cierra y registra las inconsistencias EGM.
set -uo pipefail
cd "$HOME" || exit 1
THRESHOLD=${EGM_SILENCE_SEC:-300}
CLI="$HOME/.paperclip/cli/current/node_modules/paperclipai/dist/index.js"
API="${PAPERCLIP_API_BASE:-http://100.82.79.91:3100}"
LOGS="$HOME/.paperclip/instances/default/data/run-logs"
AUDIT="$HOME/egm-run-audit.sh"
now=$(date +%s)
killed=0; audited=0; bad=0

status_of() {
  node "$CLI" agent get "$1" --api-base "$API" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).status||""))}catch(e){}})'
}

# --- auditoría de corridas cerradas (una vez por corrida)
for f in $(find "$LOGS" -name '*.ndjson' -mmin -240 2>/dev/null); do
  grep -q "lifecycle: run" "$f" || continue
  [ -f "$f.audited" ] && continue
  [ -x "$AUDIT" ] || continue
  out="$(bash "$AUDIT" "$f" 2>&1)"
  echo "$out" >> "$HOME/egm-run-audit.log"
  echo "$out" | grep -q "VEREDICTO: revisar" && { bad=$((bad+1)); echo "$out" | tail -1 >> "$HOME/egm-audit-alerts.log"; }
  touch "$f.audited"; audited=$((audited+1))
done

# --- log más reciente por agente
declare -A newest
for f in $(find "$LOGS" -name "*.ndjson" -mmin -240 2>/dev/null); do
  agent="$(basename "$(dirname "$f")")"
  mt="$(stat -c %Y "$f")"
  cur="${newest[$agent]:-0}"; curmt="${cur%%|*}"
  if [ "$mt" -gt "$curmt" ]; then newest[$agent]="$mt|$f"; fi
done
for agent in "${!newest[@]}"; do
  entry="${newest[$agent]}"
  mt="${entry%%|*}"
  f="${entry#*|}"
  age=$(( now - mt ))
  [ "$age" -lt "$THRESHOLD" ] && continue
  st="$(status_of "$agent")"
  [ "$st" = "running" ] || continue
  echo "$(date -Is) run $(basename "$f" .ndjson) mudo ${age}s · agente $agent en $st -> pause"
  node "$CLI" agent pause "$agent" --api-base "$API" --json >/dev/null 2>&1 && killed=$((killed+1))
done
echo "$(date -Is) guard: cortados=$killed auditados=$audited inconsistentes=$bad"
