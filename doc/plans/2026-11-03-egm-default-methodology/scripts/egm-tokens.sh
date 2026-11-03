#!/usr/bin/env bash
# Tablero de tokens por corrida y por agente (la metrica real: el pool es
# hardware propio, el costo en dolares es 0).
set -uo pipefail
cd "$HOME" || exit 1
LOGS="${PAPERCLIP_INSTANCE_DIR:-/home/paperclip/.paperclip/instances/default}/data/run-logs"
OUT="$HOME/egm-tokens-report.md"
node -e '
const fs=require("fs"), path=require("path");
const ROOT=process.argv[1];
const rows=[];
function walk(d){let e=[];try{e=fs.readdirSync(d,{withFileTypes:true})}catch{return}
 for(const x of e){const p=path.join(d,x.name); if(x.isDirectory())walk(p); else if(x.name.endsWith(".ndjson"))rows.push(p);}}
walk(ROOT);
const out=[];
for(const f of rows){
  const chunks=fs.readFileSync(f,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l).chunk||""}catch{return ""}}).join("");
  let steps=0,input=0,output=0,reason=0,cache=0,tools=0,gold=0;
  for(const line of chunks.split("\n")){try{const j=JSON.parse(line);
    if(j.type==="step_finish"&&j.part&&j.part.tokens){steps++;const t=j.part.tokens;input+=t.input||0;output+=t.output||0;reason+=t.reasoning||0;cache+=(t.cache&&t.cache.read)||0;}
    if(j.type==="tool_use"&&j.part){tools++;const s=j.part.state&&j.part.state.input&&j.part.state.input.subagent_type;if(s)gold++;}
  }catch(e){}}
  if(!steps) continue;
  const closed=/lifecycle: run/.test(chunks);
  out.push({run:path.basename(f,".ndjson"),agent:path.basename(path.dirname(f)),steps,input,output,reason,cache,tools,gold,closed});
}
out.sort((a,b)=>b.input-a.input);
const tot=out.reduce((a,r)=>({input:a.input+r.input,output:a.output+r.output,reason:a.reason+r.reason,cache:a.cache+r.cache,gold:a.gold+r.gold}),{input:0,output:0,reason:0,cache:0,gold:0});
const byAgent={};
for(const r of out){const a=byAgent[r.agent]||(byAgent[r.agent]={n:0,input:0,output:0,reason:0,gold:0});a.n++;a.input+=r.input;a.output+=r.output;a.reason+=r.reason;a.gold+=r.gold;}
const L=[];
L.push("# Tokens por corrida (Paperclip + EGM)","","Generado: "+new Date().toISOString().slice(0,16).replace("T"," ")+" UTC","");
L.push("| corrida | agente | steps | in | out | reasoning | cache leída | tools | oro | cerrada |");
L.push("|---|---|--:|--:|--:|--:|--:|--:|--:|---|");
for(const r of out.slice(0,25)) L.push(`| ${r.run.slice(0,8)} | ${r.agent.slice(0,8)} | ${r.steps} | ${r.input} | ${r.output} | ${r.reason} | ${r.cache} | ${r.tools} | ${r.gold} | ${r.closed?"sí":"no"} |`);
L.push("","## Por agente","","| agente | corridas | in | out | reasoning | oro |","|---|--:|--:|--:|--:|--:|");
for(const [a,v] of Object.entries(byAgent).sort((x,y)=>y[1].input-x[1].input)) L.push(`| ${a.slice(0,12)} | ${v.n} | ${v.input} | ${v.output} | ${v.reason} | ${v.gold} |`);
L.push("","## Totales","",`- corridas: **${out.length}**`,`- tokens in: **${tot.input}**`,`- tokens out: **${tot.output}**`,`- reasoning: **${tot.reason}**`,`- cache leída: **${tot.cache}**`,`- despachos de oro: **${tot.gold}**`);
fs.writeFileSync(process.argv[2],L.join("\n")+"\n");
console.log(L.join("\n"));
' "$LOGS" "$OUT"
