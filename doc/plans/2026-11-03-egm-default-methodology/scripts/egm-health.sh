#!/usr/bin/env bash
# Health check de la metodología EGM: instancia + PER PROYECTO.
# Sale 0 = sano, != 0 = hay algo que rompe EGM.
#
# Requisitos: correr como el usuario del servicio, con HOME seteado y un cwd
# que NO sea /root (OpenCode aborta con PermissionDenied al buscar config).

set -uo pipefail

# OpenCode y find abortan si el cwd es /root (no puede leer su config):
cd "$HOME" || { echo "no puedo entrar a HOME=$HOME"; exit 1; }

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
AGENTS_MD="$CONFIG_DIR/AGENTS.md"
CONFIG_JSON="$CONFIG_DIR/opencode.json"
BUNDLE="${EGM_BUNDLE:-/home/paperclip/egm-opencode-v1}"
INSTANCE="${PAPERCLIP_INSTANCE_DIR:-$HOME/.paperclip/instances/default}"
[ -d "$INSTANCE" ] || INSTANCE=/home/paperclip/.paperclip/instances/default
CLI="$HOME/.paperclip/cli/current/node_modules/paperclipai/dist/index.js"
API="${PAPERCLIP_API_BASE:-http://100.82.79.91:3100}"
COMPANY="${EGM_COMPANY:-1e4f0704-f649-4c32-ba7d-19ce08084939}"

fail=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FALLA %s\n' "$1"; fail=$((fail + 1)); }
info() { printf '  info  %s\n' "$1"; }

echo "EGM health — $(date -Is)"
echo "config: $CONFIG_DIR"

# 1. La regla de gate existe y tiene los tres niveles.
if [ -s "$AGENTS_MD" ]; then
  ok "AGENTS.md global presente ($(wc -c <"$AGENTS_MD") bytes)"
  for needle in "EGM-off" "EGM-lite" "EGM-full" "Perilla por proyecto" "Anti-loop"; do
    grep -q -- "$needle" "$AGENTS_MD" && ok "regla contiene: $needle" || bad "regla NO contiene: $needle"
  done
else
  bad "falta $AGENTS_MD (la metodología desapareció)"
fi

# 2. El bundle y sus skills canónicas.
if [ -d "$BUNDLE/bundle/skills" ]; then
  n=$(find "$BUNDLE/bundle/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
  [ "$n" -ge 7 ] && ok "bundle con $n skills" || bad "bundle con $n skills (esperado >= 7)"
else
  bad "falta el bundle en $BUNDLE"
fi

# 3. Config resuelto por OpenCode: agentes, modelos del oro, small_model, provider.
if [ -f "$CONFIG_JSON" ]; then
  resolved="$(opencode debug config 2>/dev/null)"
  if [ -z "$resolved" ]; then
    bad "opencode debug config no devolvió nada"
  else
    node -e '
      const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const checks = [];
      const agents = c.agent || {};
      const reviewers = Object.keys(agents).filter((n) => n !== "egm");
      checks.push(["egm primary registrado", Boolean(agents.egm) && agents.egm.mode === "primary"]);
      checks.push(["7 revisores registrados", reviewers.length === 7]);
      checks.push(["oro en sesión nueva (subagent)", reviewers.every((n) => agents[n].mode === "subagent")]);
      checks.push(["oro en jaula read-only", reviewers.every((n) => JSON.stringify(agents[n].permission || {}).includes("\"grep\":\"deny\"") || JSON.stringify(agents[n].permission || {}).includes("\"grep\": \"deny\""))]);
      checks.push(["oro NO puede escribir", reviewers.every((n) => agents[n].permission?.edit === "deny" && agents[n].permission?.write === "deny")]);
      checks.push(["oro puede leer el artefacto", reviewers.every((n) => JSON.stringify(agents[n].permission?.external_directory || {}).includes("/home/paperclip/egm-artifacts"))]);
      checks.push(["oro en el lane barato (sin thinking)", reviewers.every((n) => String(agents[n].model || "").endsWith("clusty-nothink"))]);
      checks.push(["small_model barato", String(c.small_model || "").endsWith("clusty-nothink")]);
      checks.push(["skills.paths declarado", Boolean(c.skills && Array.isArray(c.skills.paths) && c.skills.paths.length > 0)]);
      checks.push(["provider pool disponible", Boolean(c.provider && c.provider.pool && c.provider.pool.models && c.provider.pool.models["clusty-nothink"])]);
      checks.push(["sin default_agent secuestrando los runs", !c.default_agent]);
      // La regla global la auto-carga OpenCode desde el config dir; declararla
      // además en `instructions` la inyecta dos veces (~2k tokens por run).
      checks.push(["regla global NO duplicada en instructions", !Array.isArray(c.instructions) || c.instructions.length === 0]);
      for (const [label, passed] of checks) console.log((passed ? "  ok    " : "  FALLA ") + label);
      process.exit(checks.every(([, p]) => p) ? 0 : 1);
    ' <<<"$resolved"
    [ $? -eq 0 ] || fail=$((fail + 1))
  fi
else
  bad "falta $CONFIG_JSON"
fi

# 4. Las skills: los archivos son la fuente (se leen con Read) y además el
#    runtime las anuncia. `opencode debug skill` es no determinista (se observó
#    2, 3 y 7 en corridas seguidas), así que se muestrea y se exige lo
#    determinista: los 7 SKILL.md legibles y al menos un egm-* anunciado.
missing=0
for d in "$BUNDLE/skills"/*/; do
  [ -r "$d/SKILL.md" ] || { bad "SKILL.md ilegible: $d"; missing=$((missing + 1)); }
done
[ "$missing" -eq 0 ] && ok "los 7 SKILL.md son legibles en disco"

if command -v opencode >/dev/null 2>&1; then
  best=0
  for _ in 1 2 3 4; do
    n="$(opencode debug skill 2>/dev/null | grep -c '"name": "egm-')"
    [ "${n:-0}" -gt "$best" ] && best="$n"
  done
  if [ "$best" -ge 1 ]; then
    ok "runtime anuncia skills egm-* (mejor muestra: $best; no determinista)"
  else
    bad "el runtime no anunció ninguna skill egm-*"
  fi
else
  bad "opencode no está en PATH"
fi

# 5. POR PROYECTO: perilla EGM válida y checkout con origin canónico.
#    (Sin esto, un proyecto puede quedar sin metodología o con el workspace
#    roto — exactamente las dos fallas que ya nos pasaron.)
if [ -f "$CLI" ]; then
  projects="$(node "$CLI" project list -C "$COMPANY" --api-base "$API" --json 2>/dev/null)"
  if [ -z "$projects" ]; then
    bad "no pude listar proyectos (CLI/API)"
  else
    node -e '
      const fs = require("fs");
      const path = require("path");
      const projects = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const [instance, company] = [process.argv[2], process.argv[3]];
      const VALID = new Set(["full", "gate", "off"]);
      let problems = 0;
      for (const p of projects) {
        const raw = p.env && p.env.EGM;
        const value = raw && typeof raw === "object" ? raw.value : raw;
        if (value != null && !VALID.has(String(value))) {
          console.log(`  FALLA ${p.name}: EGM="${value}" inválido (usar full|gate|off)"`);
          problems++;
          continue;
        }
        const dir = path.join(instance, "projects", company, p.id);
        let checkouts = [];
        try { checkouts = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, ".git"))); } catch {}
        if (checkouts.length === 0) {
          console.log(`  info  ${p.name}: EGM=${value ?? "(sin perilla -> gate)"} | sin checkout local`);
          continue;
        }
        let dirty = 0;
        for (const c of checkouts) {
          const cfg = path.join(dir, c, ".git", "config");
          let txt = "";
          try { txt = fs.readFileSync(cfg, "utf8"); } catch { continue; }
          if (/@github\.com/.test(txt)) dirty++;
        }
        if (dirty > 0) {
          console.log(`  FALLA ${p.name}: ${dirty} checkout(s) con credencial en el origin (rompe workspace_validation)`);
          problems++;
        } else {
          console.log(`  ok    ${p.name}: EGM=${value ?? "(sin perilla -> gate)"} | ${checkouts.length} checkout(s), origin canónico`);
        }
      }
      process.exit(problems > 0 ? 1 : 0);
    ' <(printf '%s' "$projects") "$INSTANCE" "$COMPANY"
    [ $? -eq 0 ] || fail=$((fail + 1))
  fi
else
  info "CLI de Paperclip no encontrada: salto el chequeo por proyecto"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "RESULTADO: sano"
  exit 0
fi
echo "RESULTADO: $fail falla(s) — la metodología no está garantizada"
exit 1
