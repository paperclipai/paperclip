#!/usr/bin/env bash
# Auditoría de UNA corrida contra la metodología EGM.
#
#   bash egm-run-audit.sh <runId | ruta-al-ndjson>
#
# Responde, con datos del propio run-log: qué nivel se aplicó, si despachó oro,
# si produjo artefactos, cuántos tokens costó y si hubo bucles.
# Sale 0 si la corrida es consistente con el nivel que eligió; 1 si no.

set -uo pipefail
cd "$HOME" || exit 1

INSTANCE="${PAPERCLIP_INSTANCE_DIR:-$HOME/.paperclip/instances/default}"
[ -d "$INSTANCE" ] || INSTANCE=/home/paperclip/.paperclip/instances/default
ARG="${1:-}"
if [ -z "$ARG" ]; then echo "uso: $0 <runId | ndjson>"; exit 2; fi

if [ -f "$ARG" ]; then LOG="$ARG"; else
  LOG="$(find "$INSTANCE/data/run-logs" -name "$ARG.ndjson" 2>/dev/null | head -1)"
fi
[ -f "$LOG" ] || { echo "no encontré el run-log de $ARG"; exit 2; }

echo "run: $(basename "$LOG" .ndjson)"
node -e '
const fs = require("fs");
const chunks = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l).chunk || "" } catch { return "" } }).join("");
const text = chunks;
let steps = 0, input = 0, output = 0, reasoning = 0, endReason = null;
const tools = {}; const goldfish = []; const writes = []; const skills = new Set();
const sigs = {};
for (const line of text.split("\n")) {
  let j; try { j = JSON.parse(line) } catch { continue }
  if (j.type === "step_finish" && j.part?.tokens) {
    steps++; const t = j.part.tokens;
    input += t.input || 0; output += t.output || 0; reasoning += t.reasoning || 0;
    if (j.part.reason === "stop") endReason = "stop";
  }
  if (j.type !== "tool_use" || !j.part) continue;
  const tool = j.part.tool; const inp = j.part.state?.input || {};
  tools[tool] = (tools[tool] || 0) + 1;
  if (inp.subagent_type) goldfish.push(inp.subagent_type);
  if (inp.name && /^egm-/.test(String(inp.name))) skills.add(String(inp.name));
  const p2 = String(inp.filePath || inp.path || "");
  const mRe = /\/skills\/(egm-[a-z-]+)\/SKILL\.md/.exec(p2);
  if (mRe) skills.add(mRe[1] + " (read)");
  if (tool === "write" || tool === "edit") writes.push(String(inp.filePath || inp.path || "").split("/").pop());
  // firma completa (hash): dos scripts distintos con el mismo prefijo NO son un loop
  const raw = String(inp.command || inp.filePath || inp.path || inp.pattern || "");
  const h = require("crypto").createHash("sha1").update(raw).digest("hex").slice(0, 12);
  const sig = tool + "::" + String(inp.subagent_type || "") + "::" + h;
  sigs[sig] = (sigs[sig] || 0) + 1;
}

const loops = Object.entries(sigs).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
const egm = /EGM=(full|gate|off)/.exec(text);
const fromCmd = /\n(full|gate|off)\n---/.exec(text) || /printenv EGM[\s\S]{0,400}?(full|gate|off)\b/.exec(text);
const level = egm ? egm[1]
  : fromCmd ? fromCmd[1]
  : (/(EGM-off|EGM-lite|EGM-full)/.exec(text) || [])[1] || "(no declarado)";
const finished = /lifecycle: run (succeeded|failed)/.test(text);

const rows = [
  ["nivel aplicado", level],
  ["steps", steps],
  ["tokens", `in ${input} · out ${output} · reasoning ${reasoning}`],
  ["skills egm invocadas", [...skills].join(", ") || "(ninguna)"],
  ["oro despachado", goldfish.length ? `${goldfish.length}: ${goldfish.join(", ")}` : "(ninguno)"],
  ["artefactos escritos", writes.join(", ") || "(ninguno)"],
  ["llamadas repetidas (>=3)", loops.length ? loops.map(([k, n]) => `${n}x ${k.slice(0, 60)}`).join(" | ") : "(ninguna)"],
  ["terminó", finished ? "sí" : "no (en curso)"],
];
for (const [k, v] of rows) console.log(`  ${k.padEnd(26)} ${v}`);

// Consistencia: un artefacto de diseño con nivel full/lite debe tener oro.
const wantsGoldfish = /EGM-(full|lite)/.test(level);
const problems = [];
if (wantsGoldfish && goldfish.length === 0 && finished) problems.push("terminó sin despachar oro");
if (finished && writes.length === 0 && goldfish.length > 0) problems.push("despachó oro pero no escribió reportes");
if (loops.length > 0) problems.push("posible bucle de llamadas repetidas");
if (problems.length) { console.log("VEREDICTO: revisar -> " + problems.join("; ")); process.exit(1); }
console.log(finished ? "VEREDICTO: consistente" : "VEREDICTO: en curso");
' "$LOG"
