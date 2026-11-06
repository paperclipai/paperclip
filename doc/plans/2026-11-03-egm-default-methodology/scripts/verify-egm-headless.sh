#!/usr/bin/env bash
# Verifica que EGM funcione headless en este host, con la forma exacta en que lo invoca
# Paperclip (claude --print, sin humano, sin slash commands).
#
# Uso:
#   ./verify-egm-headless.sh              # corre todos los chequeos
#   ./verify-egm-headless.sh --print-root # solo imprime la ruta resuelta del plugin
#   SKIP_PROBE_B=1 ./verify-egm-headless.sh   # saltea el goldfish de prueba (rapido, barato)
#   PROBE_MODEL=claude-sonnet-4-5 ./verify-egm-headless.sh   # modelo explicito (gateways ruteados)
#   PROBE_TIMEOUT=120 ./verify-egm-headless.sh                # segundos por intento headless
#   EGM_ROOT=/ruta/egm ./verify-egm-headless.sh   # forzar una raiz (ruta --plugin-dir)
#
# Correr COMO EL USUARIO QUE SERVE PAPERCLIP. El plugin se resuelve desde su
# ~/.claude (Paperclip no pisa CLAUDE_CONFIG_DIR en runs locales sin filesystemScope:
# packages/adapters/claude-local/src/server/execute.ts:573).

set -uo pipefail

PROBE_TIMEOUT="${PROBE_TIMEOUT:-240}"   # segundos por intento headless
MIN_VERSION="2.1.271"
PASS=0
FAIL=0
SKIP=0

ok()   { printf 'PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf 'WARN  %s\n' "$1"; }
skip() { printf 'SKIP  %s\n' "$1"; SKIP=$((SKIP+1)); }
head_() { printf '\n== %s\n' "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

if ! have claude; then
  printf 'FAIL  claude CLI no esta en PATH para este usuario\n'
  printf '      Paperclip ejecuta el binario como el usuario del servicio.\n'
  exit 1
fi

version_of() { claude --version 2>/dev/null | tr -dc '0-9.' | cut -d. -f1-3 | head -1; }
ver_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]; }

resolve_root() {
  if [ -n "${EGM_ROOT:-}" ]; then printf '%s' "$EGM_ROOT"; return; fi
  if have jq; then
    local p
    p=$(claude plugin list --json 2>/dev/null \
        | jq -r '[.[] | select((.id // .name // "") | test("^egm(@|$)")) | .installPath // .path // empty] | first' 2>/dev/null)
    if [ -n "$p" ] && [ -d "$p" ]; then printf '%s' "$p"; return; fi
  fi
  local cand
  cand=$(ls -1d "$HOME/.claude/plugins/cache/egm/egm"/*/ 2>/dev/null | sort -V | tail -1)
  [ -n "$cand" ] && printf '%s' "${cand%/}"
}

if [ "${1:-}" = "--print-root" ]; then
  r=$(resolve_root)
  if [ -z "$r" ]; then printf 'egm@egm no esta instalado para %s\n' "$(whoami)" >&2; exit 2; fi
  printf 'EGM_PLUGIN_ROOT=%s\n' "$r"
  exit 0
fi

ROOT=$(resolve_root)

# ---------------------------------------------------------------- CLI / plugin
head_ "1. Herramientas del host"
V=$(version_of)
if [ -z "$V" ]; then
  bad "no se pudo leer la version de claude"
elif ver_ge "$V" "$MIN_VERSION"; then
  ok  "claude $V (>= $MIN_VERSION, necesario para omitClaudeMd en los revisores)"
else
  bad "claude $V < $MIN_VERSION — los goldfish no quedan aislados del CLAUDE.md del proyecto"
fi
have jq  && ok "jq disponible" || warn "sin jq: la resolucion de EGM_PLUGIN_ROOT y el fallback runtime del protocolo no van a funcionar"

head_ "2. Plugin egm@egm instalado y habilitado"
if [ -z "$ROOT" ]; then
  bad "egm@egm no aparece instalado para $(whoami) — ver README paso 1"
  printf '\nNo se puede continuar sin plugin. FAIL=%d\n' "$FAIL"; exit 1
fi
ok "installPath: $ROOT"
if have jq; then
  EN=$(claude plugin list --json 2>/dev/null | jq -r '[.[] | select((.id // .name // "") | test("^egm(@|$)")) | (.enabled // true)] | first')
  case "$EN" in
    true|null) ok "plugin habilitado (enabled=$EN)" ;;
    *) bad "plugin instalado pero enabled=$EN — correr: claude plugin enable egm@egm" ;;
  esac
else
  skip "estado enabled (sin jq)"
fi

head_ "3. Manifiesto y recursos que EGM necesita en runtime"
claude plugin validate "$ROOT" >/tmp/egm-validate.$$.log 2>&1 \
  && ok "claude plugin validate paso" \
  || bad "claude plugin validate fallo — ver /tmp/egm-validate.$$.log"
for d in skills agents resources/document_standards docs; do
  [ -d "$ROOT/$d" ] && ok "$d/ presente" || bad "$d/ ausente: skill-only install, EGM roto. Instalar el plugin completo."
done
for s in egm-brainstorm egm-draft egm-review egm-resolve egm-review-loop egm-bootstrap egm-drift-report; do
  [ -f "$ROOT/skills/$s/SKILL.md" ] || bad "skills/$s/SKILL.md ausente"
done
NA=$(find "$ROOT/agents" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
NS=$(find "$ROOT/resources/document_standards" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
[ "${NA:-0}" -gt 0 ] && ok "$NA personas revisoras en agents/" || bad "0 personas en agents/: no hay goldfish"
[ "${NS:-0}" -gt 0 ] && ok "$NS estandares en resources/document_standards/" || bad "0 estandares en resources/document_standards/"

# ---------------------------------------------------------------- helpers probe
# Faithful to Paperclip: claude --print con el prompt por STDIN
# (packages/adapters/claude-local/src/server/execute.ts:980), no por -p.
# Uso: run_headless <timeout-seg> <cwd> [args-extra-claude...] <prompt>
run_headless() {
  local t="$1" cwd="$2" prompt extra_args=()
  shift 2
  if [ "$#" -gt 1 ]; then
    prompt="${@: -1}"
    extra_args=( "${@:1:$(( $# - 1 ))}" )
  else
    prompt="${1:-}"
  fi
  local cmd=( claude --print --dangerously-skip-permissions --output-format text )
  [ -n "${PROBE_MODEL:-}" ] && cmd+=( --model "$PROBE_MODEL" )
  [ "${#extra_args[@]}" -gt 0 ] && cmd+=( "${extra_args[@]}" )
  have timeout && cmd=( timeout "$t" "${cmd[@]}" )
  {
    printf '\n===== %s | claude --print%s\n' "$(date -u +%FT%TZ)" "${PROBE_MODEL:+ --model $PROBE_MODEL}"
    printf -- '--- prompt ---\n%s\n--- salida ---\n' "$prompt"
  } >> "$LOG"
  local out
  out=$( cd "$cwd" && printf '%s' "$prompt" | "${cmd[@]}" 2>&1 )
  printf '%s\n===== fin\n' "$out" >> "$LOG"
  printf '%s\n' "$out"
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/egm-verify.XXXXXX")
LOG="${TMPDIR:-/tmp}/egm-verify-transcript.log"
: > "$LOG"
trap 'rm -rf "$TMP"' EXIT
printf 'Transcript de los probes: %s\n' "$LOG"
printf 'Nota: Probe A y Probe B corren Claude Code de verdad; pueden tardar 1-5 min cada uno.\n'
printf '      PROBE_TIMEOUT=<seg> para acotar (actual: %ss por intento).\n' "${PROBE_TIMEOUT:-240}"

# ------------------------------------------------- probe 0: round trip headless
head_ "4. Probe 0 — round trip headless minimo (antes de culpar a EGM)"
OUT_0=$(run_headless "$PROBE_TIMEOUT" "$TMP" "Respondé exactamente PONG y nada mas.")
classify_failure() {
  local out="$1"
  if printf '%s' "$out" | grep -qi 'unrecognized_model\|invalid.*model\|model not found'; then
    local smodel="?"; have jq && smodel=$(jq -r '.model // "<unset>"' "$HOME/.claude/settings.json" 2>/dev/null)
    local amodel="${ANTHROPIC_MODEL:-<unset en el shell>}"
    have jq && [ "${ANTHROPIC_MODEL:-}" = "" ] && amodel=$(jq -r '.env.ANTHROPIC_MODEL // "<unset>"' "$HOME/.claude/settings.json" 2>/dev/null)
    bad "el run headless cayo por MODELO: este entorno resuelve un modelo que el gateway rechaza"
    printf '      ANTHROPIC_MODEL=%s | model en settings.json: %s\n' "$amodel" "$smodel"
    printf '      DETALLE: %s\n' "$(printf '%s\n' "$out" | grep -i 'model' | head -2 | sed 's/^/      /')"
    warn "reprobe con PROBE_MODEL=<modelo-que-acepta-tu-gateway> ./verify-egm-headless.sh"
    warn "ojo: en --print el CLI consulta con query_source=sdk; un gateway puede rechazar ahi"
    warn "    y andar bien en interactivo. Paperclip pasa --model del agente, asi que un run de"
    warn "    Paperclip puede funcionar aunque este probe falle sin PROBE_MODEL."
    printf '%s' "$out" | grep -qi 'timed out' && \
      warn "el CLI tambien reporto 'Request timed out': el rechazo de modelo se ve como timeout"
    warn "y en Paperclip: los agentes que usen EGM necesitan un modelo que soporte subagentes"
    warn "(los adaptadores de revisor declaran model: inherit, heredan el del run)"
  elif printf '%s' "$out" | grep -qi '401\|403\|invalid.*key\|unauthorized\|not logged in'; then
    bad "el run headless cayo por AUTENTICACION de $(whoami) en este host"
    printf '      DETALLE: %s\n' "$(printf '%s\n' "$out" | grep -i -m2 'key\|auth\|login' | sed 's/^/      /')"
  elif printf '%s' "$out" | grep -qi 'ECONNREFUSED\|ENOTFOUND\|timed out\|fetch failed'; then
    bad "el run headless cayo por RED: no alcanza el endpoint del modelo"
    printf '      ANTHROPIC_BASE_URL=%s\n' "${ANTHROPIC_BASE_URL:-<unset, api.anthropic.com>}"
  else
    bad "el run headless no respondio (salida vacia o inesperada)"
    printf '      salida:\n%s\n' "$(printf '%s\n' "$out" | tail -6 | sed 's/^/      /')"
  fi
}
if printf '%s' "$OUT_0" | grep -q 'PONG'; then
  ok "claude --print responde en este host"
else
  classify_failure "$OUT_0"
  printf '\nSin round trip headless los probes de EGM no valen nada. Aborto aca.\n'
  printf 'PASS=%d FAIL=%d SKIP=%d\n' "$PASS" "$FAIL" "$SKIP"
  exit 1
fi

# ------------------------------------------------- probe A: skill sin slash command
head_ "5. Probe A — leer y seguir un SKILL.md headless (el disparador del protocolo)"
F="$ROOT/skills/egm-brainstorm/SKILL.md"
LINE8=$(awk 'NF && ++c==8 {print; exit}' "$F")
HEADING=$(grep -m1 '^# ' "$F" || true)
PROMPT_A="Estas headless, no hay slash commands ni herramienta Skill para egm-*.
Leé con la herramienta Read el archivo exacto: $F
Despues respondé exactamente dos lineas, sin nada mas:
EGM_PROBE_A8=<la octava linea no vacia del archivo, verbatim, sin comillas ni backticks>
<la primera linea del archivo que empieza con '# ', verbatim>"
OUT_A=$(run_headless "$PROBE_TIMEOUT" "$TMP" "$PROMPT_A")
GOT8=$(printf '%s\n' "$OUT_A" | grep -m1 '^EGM_PROBE_A8=' | sed 's/^EGM_PROBE_A8=//' \
       | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
EXP8=$(printf '%s' "$LINE8" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
probe_a_ok=1
if [ -z "$GOT8" ]; then
  bad "Probe A no devolvio el marcador EGM_PROBE_A8"
  probe_a_ok=0
elif [ "$GOT8" = "$EXP8" ] || printf '%s' "$GOT8" | grep -Fq -- "$EXP8"; then
  ok "el modelo leyo el SKILL.md real headless (octava linea no vacia coincide)"
else
  bad "la linea copiada no coincide: no leyo el archivo de verdad"
  printf '      esperado: %s\n      obtenido: %s\n' "$EXP8" "$GOT8"
  probe_a_ok=0
fi
if [ "$probe_a_ok" = "1" ] && [ -n "$HEADING" ] && ! printf '%s\n' "$OUT_A" | grep -Fq -- "$HEADING"; then
  warn "no se encontro el encabezado '$HEADING' en la salida (revisá vos la transcripcion)"
fi
if [ "$probe_a_ok" = "0" ]; then
  printf '      salida del run:\n%s\n' "$(printf '%s\n' "$OUT_A" | tail -8 | sed 's/^/      /')"
  warn "reintento con --setting-sources user (Paperclip solo lo pasa con managedAiConnection)"
  OUT_A2=$(run_headless "$PROBE_TIMEOUT" "$TMP" --setting-sources user "$PROMPT_A")
  if printf '%s\n' "$OUT_A2" | grep -Fq -- "$EXP8"; then
    warn "CON --setting-sources user si funciona: agregalo a adapterConfig.extraArgs de cada agente que use EGM"
  fi
fi

# ------------------------------------------------- probe B: goldfish real
if [ "${SKIP_PROBE_B:-0}" = "1" ]; then
  head_ "6. Probe B — goldfish con contexto fresco"
  skip "Probe B omitido (SKIP_PROBE_B=1). Correrlo sin la variable antes de cablear Paperclip."
else
head_ "6. Probe B — un goldfish con contexto fresco (subagente del plugin)"
mkdir -p "$TMP/proj/docs/designs"
cat > "$TMP/proj/design_draft.md" <<'EOF'
# Checkout de inventario

## Resumen
Cuando un articulo se queda sin stock, el sistema manda un mail al cliente y crea una
tarea de reposicion automatica.

## Detalle
El worker de notificaciones consume eventos de `stock.depleted` de la cola.
EOF
PROMPT_B="Estas headless. No hay slash commands; NO uses la herramienta Skill con egm-*.
1. Leé $ROOT/docs/claude.md y $ROOT/skills/egm-review/SKILL.md (secciones Delegation y Subflow: Zoom Out Review).
2. Creá UN subagente revisor del plugin EGM de tipo egm:egm-zoom-out (si ese tipo no existe,
   un subagente general y decile que lea primero $ROOT/agents/zoom_out.md y
   $ROOT/resources/document_standards/zoom-out-standard.md).
   Pasale SOLO: el documento $TMP/proj/design_draft.md, esas dos rutas, y que escriba su
   reporte en $TMP/proj/docs/designs/zoom_out_probe_report.md.
3. No agregues tu propio analisis al subagente; el goldfish no debe saber nada de esta conversacion.
Cuando el reporte este escrito, respondé exactamente: EGM_PROBE_B_OK"
OUT_B=$(run_headless "$(( PROBE_TIMEOUT * 3 ))" "$TMP/proj" "$PROMPT_B")
if printf '%s\n' "$OUT_B" | grep -q 'EGM_PROBE_B_OK'; then
  RPT=$(find "$TMP/proj/docs/designs" -name '*.md' 2>/dev/null | head -1)
  if [ -n "$RPT" ] && [ "$(wc -c < "$RPT" | tr -d ' ')" -gt 150 ]; then
    ok "goldfish escribio reporte: $(basename "$RPT") ($(wc -c < "$RPT" | tr -d ' ') bytes)"
  else
    warn "dijo OK pero no aparecio un reporte legible en docs/designs/ — revisar si el subagente pudo escribir"
  fi
else
  bad "Probe B fallo: no se pudo spawnear un revisor EGM headless"
  printf '      salida del run:\n%s\n' "$(printf '%s\n' "$OUT_B" | tail -12 | sed 's/^/      /')"
  warn "causa tipica: plugin no cargado en -p, o dangerouslySkipPermissions apagado en el agente"
fi
fi

# ---------------------------------------------------------------- cierre
head_ "Resultado"
printf 'PASS=%d FAIL=%d SKIP=%d\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -eq 0 ]; then
  printf '\nEGM_PLUGIN_ROOT=%s\n' "$ROOT"
  printf 'Sustitui esa ruta en el placeholder __EGM_PLUGIN_ROOT__ de:\n'
  printf '  egm-protocol-block.md\n  goldfish-reviewer-AGENTS.md\n  skills/egm-protocol/SKILL.md\n'
  exit 0
fi
printf '\nHay fallos. No cablees el protocolo en Paperclip hasta que Probe A y Probe B pasen.\n'
exit 1
