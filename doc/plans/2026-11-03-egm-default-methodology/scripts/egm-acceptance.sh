#!/usr/bin/env bash
# Aceptación de la maquinaria Paperclip + EGM: prueba las 6 condiciones de hecho.
#   bash egm-acceptance.sh
# Salida: una línea por condición con PASS/FAIL. Sale 1 si algo falla.
set -uo pipefail
cd "$HOME" || exit 1
CLI="$HOME/.paperclip/cli/current/node_modules/paperclipai/dist/index.js"
API="${PAPERCLIP_API_BASE:-http://100.82.79.91:3100}"
CO=1e4f0704-f649-4c32-ba7d-19ce08084939
VICIN=c5fb51c8-3a4c-4dba-90f3-fa93374d19e1
OMA594=87fbb70f-c338-4c5d-9178-4410e3cf45b9
pass=0; fail=0
say() { if [ "$1" = "0" ]; then printf '  PASS  %s\n' "$2"; pass=$((pass+1)); else printf '  FAIL  %s\n' "$2"; fail=$((fail+1)); fi; }

echo "=== Aceptación Paperclip + EGM — $(date -Is) ==="

# 1. EGM intrínseco y verificable, por proyecto
out="$(bash "$HOME/egm-health.sh" 2>&1)"; rc=$?
echo "$out" | grep -E "^  (ok|FALLA)" | sed 's/^/    /' | tail -12
say $rc "health de la instancia y de cada proyecto"
n=$(echo "$out" | grep -cE "^  (ok|info) +[A-Za-z-]+: EGM="); say $([ "$n" -ge 8 ] && echo 0 || echo 1) "$n proyectos con perilla EGM (full|gate|off) verificada"

# 2. flota sana
agents="$(node "$CLI" agent list -C $CO --api-base $API --json 2>/dev/null)"
idle=$(echo "$agents" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.stdout.write(String(a.filter(x=>x.adapterType==="opencode_local"&&x.status==="idle").length))})')
clusty=$(echo "$agents" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.stdout.write(String(a.filter(x=>x.adapterType==="opencode_local"&&/litellm\/clusty/.test(x.adapterConfig.model||"")).length))})')
# el id se verifica contra la DB (fuente de verdad), no contra el disco materializado
dead=$(node -e '
const http=require("http");const fs=require("fs");
const API="http://100.82.79.91:3100";const CO="1e4f0704-f649-4c32-ba7d-19ce08084939";
const TOK=JSON.parse(fs.readFileSync("/home/paperclip/.paperclip/auth.json","utf8")).credentials[API].token;
function req(p){return new Promise((res,rej)=>{const r=http.request({host:"100.82.79.91",port:3100,path:p,headers:{Authorization:"Bearer "+TOK}},(x)=>{let s="";x.on("data",(c)=>s+=c);x.on("end",()=>{try{res(JSON.parse(s||"null"))}catch(e){res(null)}})});r.on("error",rej);r.end()})}
(async()=>{const a=await req("/api/companies/"+CO+"/agents");const l=Array.isArray(a)?a:(a.agents||a.data||[]);
let n=0;for(const ag of l){const entry=ag.adapterConfig?.instructionsEntryFile||"AGENTS.md";
const c=await req("/api/agents/"+ag.id+"/instructions-bundle/file?path="+encodeURIComponent(entry));
const txt=(c&&(c.content||c.file?.content))||"";if(txt.includes("344e88b5"))n++;}
process.stdout.write(String(n))})()' 2>/dev/null)
hist=$(grep -rl "344e88b5" /home/paperclip/.paperclip/instances/default/companies/$CO/agents/*/file-sync/runs/ 2>/dev/null | wc -l | tr -d ' ')
say $([ "$idle" -ge 7 ] && echo 0 || echo 1) "$idle agentes opencode idle (asignables, sin polling)"
say $([ "$clusty" -ge 7 ] && echo 0 || echo 1) "$clusty agentes en litellm/clusty"
say $([ "$dead" = "0" ] && echo 0 || echo 1) "0 referencias al agentId de handoff muerto en las instrucciones vivas ($hist copias historicas de run, sin efecto)"

# 3. ciclo EGM completo
TOK=$(node -e 'const j=require("/home/paperclip/.paperclip/auth.json");process.stdout.write(j.credentials["http://100.82.79.91:3100"].token)')
curl -s -m 20 -H "Authorization: Bearer $TOK" "$API/api/issues/$OMA594" -o /tmp/acc594.json
st=$(node -e 'const j=require("/tmp/acc594.json");const i=j.issue||j;process.stdout.write(String(i.status))')
ver=$(node -e 'const j=require("/tmp/acc594.json");const i=j.issue||j;const b=String(i.planDocument?.body||i.planDocument?.latestBody||"");const m=/EGM-VERDICT\s*:\s*(.+)/.exec(b);process.stdout.write(m?m[1].trim():"")')
pd=$(node -e 'const j=require("/tmp/acc594.json");const i=j.issue||j;process.stdout.write(String(i.planDocument?.body?.length||0))')
say $([ "$st" = "done" ] && echo 0 || echo 1) "OMA-594 cerrada (status=$st)"
say $([ "${pd:-0}" -gt 12000 ] && echo 0 || echo 1) "documento plan con diseño+síntesis ($pd bytes)"
say $([ -n "$ver" ] && echo 0 || echo 1) "veredicto EGM en el plan: ${ver:0:80}..."
N=$(ls -t /home/paperclip/.paperclip/instances/default/data/run-logs/$CO/*/*.ndjson | head -1)
gold=$(bash "$HOME/egm-run-audit.sh" "$N" 2>/dev/null | grep -oE "oro despachado +[0-9]+" | grep -oE "[0-9]+")
say $([ "${gold:-0}" -ge 5 ] && echo 0 || echo 1) "último run: $gold revisores de oro despachados"

# 4. cero loops
guard=$(systemctl is-active egm-silence-guard.timer 2>/dev/null)
loops=$(bash "$HOME/egm-run-audit.sh" "$N" 2>/dev/null | grep -cE "llamadas repetidas.*ninguna")
say $([ "$guard" = "active" ] && echo 0 || echo 1) "guardia de silencio activa (timer 2 min)"
say $([ "$loops" -ge 1 ] && echo 0 || echo 1) "sin llamadas repetidas en el último run"

# 5. fixdrop como canal
bs=$(node -e 'const s=require("/home/paperclip/fixdrop-bridge-state.json");const v=Object.values(s);process.stdout.write(v.length+"/"+v.filter(x=>x.verdictPosted).length)')
say $([ -s /home/paperclip/fixdrop-bridge-state.json ] && echo 0 || echo 1) "puente fixdrop: $bs (reportes/respondidos)"

# 6. hoke operativo y replicable
hoke=$(echo "$agents" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const h=a.find(x=>x.name==="hoke");process.stdout.write(h?h.adapterType+"/"+h.adapterConfig.model:"")})')
runbook=$(ls "$HOME"/*replicar-egm.md 2>/dev/null | wc -l | tr -d ' ')
say $([ "${hoke%%/*}" = "opencode_local" ] && echo 0 || echo 1) "hoke operativo: $hoke"
say $([ "$runbook" -ge 1 ] && echo 0 || echo 1) "runbook de replicación en el host"

echo
echo "RESULTADO: $pass PASS · $fail FAIL"
[ "$fail" -eq 0 ]
