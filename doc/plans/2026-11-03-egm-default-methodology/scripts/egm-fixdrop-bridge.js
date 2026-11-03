#!/usr/bin/env node
/**
 * Puente fixdrop -> Paperclip, v2: la issue la crea el AGENTE de intake.
 *
 * v1 (el puente creaba la issue como board) no dejaba cuarentena
 * machine-readable: `sourceTrust` lo deriva el actor, y board = confiable.
 * Ahora:
 *   1) INGERE: el puente deja el reporte del cliente como comentario en la
 *      issue "Bandeja de entrada" (asignada al agente `intake`, que tiene
 *      trustPreset=low_trust_review).
 *   2) SYNC: el agente de intake crea la issue del cliente (actor = agente de
 *      baja confianza) -> la issue NACE con sourceTrust low-trust. El puente
 *      la linkea por el marcador `fixdrop-origin:`.
 *   3) RESPUESTA: cuando esa issue llega a done con veredicto, el puente
 *      publica el veredicto en el issue original de GitHub.
 */
const fs = require("fs");
const http = require("http");
const API = "http://100.82.79.91:3100";
const CO = "1e4f0704-f649-4c32-ba7d-19ce08084939";
const CFG = "/home/paperclip/fixdrop-watch.json";
const STATE = "/home/paperclip/fixdrop-bridge-state.json";
const BOARD = JSON.parse(fs.readFileSync("/home/paperclip/.paperclip/auth.json", "utf8")).credentials[API].token;
const GH = (fs.readFileSync("/home/paperclip/.git-credentials", "utf8").match(/https:\/\/[^:]+:([^@]+)@github\.com/) || [])[1];

function httpReq(host, pathname, { method = "GET", body, headers = {} } = {}) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const mod = host === "100.82.79.91" ? http : require("https");
    const r = mod.request({ host, port: host === "100.82.79.91" ? 3100 : 443, path: pathname, method, headers: { "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}), ...headers } },
      (x) => { let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => { try { res({ status: x.statusCode, json: b ? JSON.parse(b) : null }); } catch { res({ status: x.statusCode, json: null, raw: b }); } }); });
    r.on("error", rej); if (data) r.write(data); r.end();
  });
}
const pc = (m, p, b) => httpReq("100.82.79.91", p, { method: m, body: b, headers: { Authorization: `Bearer ${BOARD}` } });
const gh = (m, p, b) => httpReq("api.github.com", p, { method: m, body: b, headers: { Authorization: `Bearer ${GH}`, Accept: "application/vnd.github+json", "User-Agent": "paperclip-fixdrop-bridge" } });
const sanitize = (s, max = 4000) => String(s || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const save = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2));

(async () => {
  const cfg = load(CFG, { repos: [], projectId: null, bandejaIssueId: null });
  const state = load(STATE, {});
  if (!cfg.bandejaIssueId) { console.log("falta bandejaIssueId en la config"); process.exit(1); }

  // ---- 1. ingesta: el reporte va a la bandeja (comment wake, atado a tarea)
  for (const repo of cfg.repos) {
    const r = await gh("GET", `/repos/${repo}/issues?state=open&per_page=20&sort=created&direction=desc`);
    for (const gi of (Array.isArray(r.json) ? r.json : [])) {
      if (gi.pull_request) continue;
      if (/paperclip-origin:|paperclip-verdict:/.test(String(gi.body || ""))) continue;
      const key = `${repo}#${gi.number}`;
      if (state[key]) continue;
      const payload = [
        `**Reporte de cliente — ${key}**`, "",
        `**URL:** ${gi.html_url}`, `**Autor:** ${gi.user?.login || "?"}`,
        `**Labels:** ${(gi.labels || []).map((l) => l.name).join(", ") || "(ninguno)"}`, "",
        "---", "", sanitize(gi.body || gi.title),
      ].join("\n");
      const c = await pc("POST", `/api/issues/${cfg.bandejaIssueId}/comments`, {
        body: payload + `\n\n_Creador de la issue para este reporte: marcador \`fixdrop-origin: ${key}\`._`,
      });
      if (c.status >= 300) { console.log(`  ERROR comentario en bandeja para ${key}: http=${c.status}`); continue; }
      state[key] = { key, repo, number: gi.number, title: gi.title, url: gi.html_url, status: "queued", createdAt: new Date().toISOString() };
      save(STATE, state);
      console.log(`  ${key} -> comentario en la bandeja (http=${c.status}); esperando que intake cree la issue`);
    }
  }

  // ---- 2. sync: la issue que creó intake (y su cuarentena)
  const issues = await pc("GET", `/api/companies/${CO}/issues?projectId=${cfg.projectId}&limit=100`);
  const ilist = Array.isArray(issues.json) ? issues.json : (issues.json.issues || issues.json.data || []);
  for (const i of ilist) {
    const m = /fixdrop-origin:\s*([^\s]+)/.exec(String(i.description || ""));
    if (!m) continue;
    const key = m[1];
    const st = state[key];
    if (!st || st.paperclipIssueId) continue;
    st.paperclipIssueId = i.id;
    st.identifier = i.identifier;
    st.status = "created";
    st.sourceTrust = i.sourceTrust || null;
    save(STATE, state);
    console.log(`  ${key} -> ${i.identifier} creada por intake · sourceTrust=${JSON.stringify(i.sourceTrust)}`);
  }

  // ---- 3. respuesta: veredicto -> GitHub
  for (const [key, st] of Object.entries(state)) {
    if (st.verdictPosted || !st.paperclipIssueId) continue;
    const d = await pc("GET", `/api/issues/${st.paperclipIssueId}`);
    const issue = d.json.issue || d.json;
    if (!issue || issue.status !== "done") continue;
    const plan = issue.planDocument || {};
    const cm = await pc("GET", `/api/issues/${st.paperclipIssueId}/comments`);
    const comments = Array.isArray(cm.json) ? cm.json : (cm.json.comments || cm.json.data || []);
    const all = [String(plan.body || plan.latestBody || ""), ...comments.map((c) => String(c.body || ""))].join("\n");
    const verdict = /EGM-VERDICT\s*:\s*([^\n]+)/.exec(all);
    if (!verdict) { console.log(`  ${key}: done sin veredicto (lo reabre el gate)`); continue; }
    const reply = ["📋 **Paperclip**: el feedback de tu reporte ya fue trabajado.", "",
      `**Veredicto EGM:** \`${verdict[1].trim()}\``,
      `**Issue interna:** ${issue.identifier}`, "**Estado:** resuelto"].join("\n");
    const p = await gh("POST", `/repos/${st.repo}/issues/${st.number}/comments`, { body: reply });
    st.verdictPosted = true; save(STATE, state);
    console.log(`  ${key}: veredicto publicado en GitHub (http=${p.status})`);
  }
})().catch((e) => { console.error("bridge error:", e.message); process.exit(1); });
