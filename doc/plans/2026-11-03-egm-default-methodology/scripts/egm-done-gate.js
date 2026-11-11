#!/usr/bin/env node
/**
 * Gate de cierre EGM (API directo): un issue de un proyecto con EGM full|gate no
 * puede quedar en `done` sin que su documento `plan` tenga la marca `EGM-VERDICT:`.
 * Si le falta: comenta el motivo y reabre. Sólo cierres recientes y con tope.
 *
 *   DRY=1 node egm-done-gate.js            # muestra
 *   EGM_GATE_ENFORCE=on node ...           # aplica
 */
const fs = require("fs");
const http = require("http");
const API = process.env.PAPERCLIP_API_BASE || "http://100.82.79.91:3100";
const CO = process.env.EGM_COMPANY || "1e4f0704-f649-4c32-ba7d-19ce08084939";
const DRY = process.env.DRY === "1";
const ENFORCE = process.env.EGM_GATE_ENFORCE === "on";
const MAX = Number(process.env.EGM_GATE_MAX || 5);
const WINDOW_DAYS = Number(process.env.EGM_GATE_WINDOW_DAYS || 14);
const AUTH = JSON.parse(fs.readFileSync("/home/paperclip/.paperclip/auth.json", "utf8"));
const TOKEN = AUTH.credentials[API].token;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(API + path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => {
        try { resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }); } catch { resolve({ status: res.statusCode, json: null, raw: b }); }
      });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}
const val = (env, k) => { const b = env && env[k]; return b ? (typeof b === "object" ? b.value : b) : undefined; };
const cutoff = Date.now() - WINDOW_DAYS * 86400000;
const SINCE = Number(process.env.EGM_GATE_SINCE || 0) * 1000;   // epoch SEGUNDOS -> ms (0 = sin corte)
const floor = Math.max(cutoff, SINCE);

(async () => {
  const projects = (await req("GET", `/api/companies/${CO}/projects`)).json;
  const list = Array.isArray(projects) ? projects : (projects.projects || projects.data || []);
  let flagged = 0, reopened = 0, checked = 0, scanned = 0;
  for (const p of list) {
    const level = val(p.env, "EGM");
    if (level !== "full" && level !== "gate") continue;
    const r = await req("GET", `/api/companies/${CO}/issues?status=done&projectId=${p.id}&limit=300`);
    const issues = Array.isArray(r.json) ? r.json : (r.json.issues || r.json.data || []);
    const recent = issues.filter((i) => Date.parse(i.updatedAt || i.createdAt || 0) >= floor);
    scanned += recent.length;
    console.log(`${p.name}: EGM=${level} · ${recent.length} cierres recientes de ${issues.length}`);
    for (const i of recent) {
      if (checked >= 60) { console.log("  (tope de chequeos)"); break; }
      const d = await req("GET", `/api/issues/${i.id}`);
      const issue = d.json.issue || d.json;
      const doc = issue.planDocument || null;
      if (!doc) continue;
      checked++;
      const body = String(doc.body || doc.latestBody || doc.content || "");
      if (/EGM-VERDICT\s*:/.test(body)) continue;
      flagged++;
      console.log(`  ${i.identifier} cerrado sin veredicto EGM (doc ${String(doc.id || "").slice(0, 8)})`);
      if (DRY || !ENFORCE || reopened >= MAX) continue;
      const msg = `El gate EGM de este proyecto (EGM=${level}) exige que el artefacto de diseño lleve veredicto. ` +
        `Este issue está en \`done\` y su documento \`plan\` no tiene la marca \`EGM-VERDICT:\`. Se reabre para que el elefante escriba la síntesis y la marque.`;
      const c = await req("POST", `/api/issues/${i.id}/comments`, { body: msg });
      const u = await req("PATCH", `/api/issues/${i.id}`, { status: "todo" });
      if (u.status < 300) { reopened++; console.log(`    -> comentado(${c.status}) y reabierto(${u.status})`); }
      else console.log(`    -> comment ${c.status} / update ${u.status}: ${String(u.json && u.json.error).slice(0, 90)}`);
    }
  }
  console.log(`gate: escaneados=${scanned} con-doc=${checked} sin-veredicto=${flagged} reabiertos=${reopened}${DRY ? " (dry-run)" : ""}`);
})().catch((e) => { console.error("gate error:", e.message); process.exit(1); });
