#!/bin/bash
# Guardia de silencio + auditoría de corridas.
# 1) Si un run sigue mudo > THRESHOLD, corta el agente que lo corre (pero solo
#    si el agente TIENE un run vivo: un log viejo sin 'lifecycle' es un run
#    muerto, no uno colgado, y pausar por eso era un bug).
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

status_of() {  # status del agente: idle|running|paused|...
  node "$CLI" agent get "$1" --api-base "$API" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).status||""))}catch(e){}})'
}

for f in $(find "$LOGS" -name '*.ndjson' -mmin -120 2>/dev/null); do
  agent=$(basename "$(dirname "$f")")
  if grep -q "lifecycle: run" "$f"; then
    # corrida cerrada: auditar una vez (marcarla)
    if [ ! -f "$f.audited" ]; then
      if [ -x "$AUDIT" ]; then
        out="$(bash "$AUDIT" "$f" 2>&1)"
        echo "$out" >> "$HOME/egm-run-audit.log"
        echo "$out" | grep -q "VEREDICTO: revisar" && { bad=$((bad+1)); echo "$out" | tail -1 >> "$HOME/egm-audit-alerts.log"; }
        touch "$f.audited"
        audited=$((audited+1))
      fi
    fi
    continue
  fi
  age=$(( now - $(stat -c %Y "$f") ))
  [ "$age" -lt "$THRESHOLD" ] && continue
  st="$(status_of "$agent")"
  if [ "$st" != "running" ]; then
    # run muerto (nunca escribió lifecycle) o agente sin run vivo: no pausar.
    continue
  fi
  echo "$(date -Is) run $(basename "$f" .ndjson) mudo ${age}s con agente $agent en $st -> pause"
  node "$CLI" agent pause "$agent" --api-base "$API" --json >/dev/null 2>&1 && killed=$((killed+1))
done
echo "$(date -Is) guard: cortados=$killed auditados=$audited inconsistentes=$bad"
