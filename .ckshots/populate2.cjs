// Batch 2: create new venue/customer accounts, B2C leads, and trade leads from the mail history.
// MODE=dry2 (default) prints the plan; MODE=apply-batch2 writes. Key via env ESPO_KEY.
const fs = require("fs");
const BASE = "http://127.0.0.1:8085/api/v1";
const KEY = process.env.ESPO_KEY;
const MODE = process.env.MODE || "dry2";
const accounts = JSON.parse(fs.readFileSync("/work/.ckshots/accounts.json")).list;
const idByName = {}; accounts.forEach((a) => (idByName[a.name] = a.id));
let emails = [];
for (const f of ["0", "200", "400"]) emails = emails.concat(JSON.parse(fs.readFileSync("/work/.ckshots/em-" + f + ".json")).list);

// act: create (new account), b2c (individual lead), trade (org lead). Others handled in batch 1 / excluded.
const MAP = {
  "gostony.ch": { act: "create", name: "Gostony", type: "Customer" },
  "royalsavoylausanne.com": { act: "create", name: "Royal Savoy Lausanne", type: "Customer" },
  "suvrettahouse.ch": { act: "create", name: "Suvretta House", type: "Customer" },
  "rollingsmoke.ch": { act: "create", name: "Rolling Smoke", type: "Customer" },
  "cucinaarte.ch": { act: "create", name: "Cucina Arte (Solothurn)", type: "Customer" },
  "sattler.ch": { act: "create", name: "Sattler", type: "Customer" },
  "golfswitzerland.ch": { act: "create", name: "Golf Switzerland", type: "Customer" },
  "finemetal.ch": { act: "create", name: "FineMetal", type: "Customer" },
  "mk-weine.ch": { act: "create", name: "MK Weine", type: "Customer" },
  "batista.ch": { act: "create", name: "Il Salotto Winterthur", type: "Customer" },
  "batmar.ch": { act: "create", name: "Il Salotto Winterthur", type: "Customer" },
  "bluewin.ch": { act: "b2c" }, "gmail.com": { act: "b2c" }, "gmx.ch": { act: "b2c" },
  "hotmail.com": { act: "b2c" }, "icloud.com": { act: "b2c" }, "me.com": { act: "b2c" }, "windowslive.com": { act: "b2c" },
  "mirex.gob.do": { act: "trade", org: "Embassy of the Dominican Republic" },
  "mived.gob.do": { act: "trade", org: "Dominican Republic (MIVED)" },
  "zaap.ch": { act: "trade", org: "ZAAP" }, "corimas.ch": { act: "trade", org: "Corimas" },
};
// Alan's own + team personal addresses that must never become buyer leads/contacts.
const DENY = new Set(["alanjohn.c@hotmail.com", "dirk.frischknecht@gmail.com"]);
const isOurs = (a) => /treshermanos|divinocigars/i.test(a);
function parties(e) {
  const out = [];
  [["from", e.fromString, e.fromName], ["to", e.to, null]].forEach(([dir, s, nm]) => String(s || "").split(";").forEach((a) => {
    const m = a.toLowerCase().match(/([a-z0-9._%+\-]+)@([a-z0-9.\-]+)/);
    if (m && !isOurs(m[0])) out.push({ dir, email: m[0], domain: m[2], name: dir === "from" ? (nm || e.fromName) : null });
  }));
  return out;
}
const plan = {}; // domain -> {...rule, emailIds:Set, addr:Map(email->{name, emails:Set})}
emails.forEach((e) => {
  const ps = parties(e); if (!ps.length) return;
  const d = ps[0].domain; const rule = MAP[d]; if (!rule) return;
  if (!plan[d]) plan[d] = { ...rule, emailIds: new Set(), addr: new Map() };
  plan[d].emailIds.add(e.id);
  ps.filter((p) => p.domain === d && !DENY.has(p.email)).forEach((p) => {
    if (!plan[d].addr.has(p.email)) plan[d].addr.set(p.email, { name: null, emails: new Set() });
    const rec = plan[d].addr.get(p.email);
    if (p.name && !rec.name) rec.name = p.name;
    rec.emails.add(e.id);
  });
});
function nameParts(full, email) {
  if (full && /[a-z]/i.test(full)) { const t = full.trim().split(/\s+/); const last = t.length > 1 ? t.pop() : t[0]; return { first: t.join(" "), last }; }
  return { first: "", last: email.split("@")[0] };
}
// summary
const G = { create: [], b2c: [], trade: [] };
Object.entries(plan).forEach(([d, p]) => G[p.act].push({ d, name: p.name || p.org, emails: p.emailIds.size, addrs: [...p.addr.entries()] }));
console.log("## CREATE accounts (dedup by name):");
const byName = {}; G.create.forEach((x) => { byName[x.name] = byName[x.name] || { emails: 0, ppl: new Set() }; byName[x.name].emails += x.emails; x.addrs.forEach(([e]) => byName[x.name].ppl.add(e)); });
Object.entries(byName).forEach(([n, v]) => console.log(`   ${n}  [${v.emails} emails, ${v.ppl.size} contacts]`));
console.log("## B2C leads:"); G.b2c.forEach((x) => x.addrs.forEach(([e, rec]) => console.log(`   ${rec.name || e}  <${e}>  (${rec.emails.size} emails)`)));
console.log("## TRADE leads:"); G.trade.forEach((x) => x.addrs.forEach(([e, rec]) => console.log(`   ${rec.name || e}  <${e}>  @ ${x.name}`)));

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "X-Api-Key": KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(method + " " + path + " -> " + r.status + " " + (await r.text()).slice(0, 100));
  return r.json();
}
// resilient write: skip on any error (e.g. 409 duplicate), return null instead of aborting the batch
async function tryApi(method, path, body) { try { return await api(method, path, body); } catch (e) { return null; } }
async function leadExists(email) { const r = await api("GET", "/Lead?where[0][type]=equals&where[0][attribute]=emailAddress&where[0][value]=" + encodeURIComponent(email) + "&maxSize=1"); return r.total > 0; }
async function contactExists(email) { const r = await api("GET", "/Contact?where[0][type]=equals&where[0][attribute]=emailAddress&where[0][value]=" + encodeURIComponent(email) + "&maxSize=1"); return r.total > 0; }
(async () => {
  if (MODE !== "apply-batch2") { console.log("\n(dry-run; set MODE=apply-batch2 to write)"); return; }
  const stat = { accounts: 0, contacts: 0, b2c: 0, trade: 0, linked: 0 };
  const newAcc = {};
  for (const [d, p] of Object.entries(plan)) {
    if (p.act !== "create") continue;
    let accId = idByName[p.name] || newAcc[p.name];
    if (!accId) { const a = await api("POST", "/Account", { name: p.name, type: p.type, website: "https://" + d }); accId = a.id; newAcc[p.name] = accId; stat.accounts++; }
    for (const eid of p.emailIds) { if (await tryApi("PUT", "/Email/" + eid, { parentType: "Account", parentId: accId })) stat.linked++; }
    for (const [email, rec] of p.addr) { if (await contactExists(email)) continue; const { first, last } = nameParts(rec.name, email); if (await tryApi("POST", "/Contact", { firstName: first, lastName: last, emailAddress: email, accountId: accId })) stat.contacts++; }
  }
  for (const [d, p] of Object.entries(plan)) {
    if (p.act !== "b2c" && p.act !== "trade") continue;
    for (const [email, rec] of p.addr) {
      if (await leadExists(email)) continue;
      const { first, last } = nameParts(rec.name, email);
      const lead = await tryApi("POST", "/Lead", { firstName: first, lastName: last, emailAddress: email, source: "Email", accountName: p.act === "trade" ? p.org : "", description: p.act === "b2c" ? "Individual buyer (from mail history)" : "Trade/intro contact (from mail history)" });
      if (!lead) continue;
      for (const eid of rec.emails) { if (await tryApi("PUT", "/Email/" + eid, { parentType: "Lead", parentId: lead.id })) stat.linked++; }
      if (p.act === "b2c") stat.b2c++; else stat.trade++;
    }
  }
  console.log("\nAPPLIED:", JSON.stringify(stat));
})();
