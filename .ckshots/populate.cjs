// Populate EspoCRM from the alan@treshermanos.ch mail history.
// MODE=dry (default) prints the plan; MODE=apply-existing links emails + creates contacts for the
// 7 venues that already exist as Accounts (high-confidence, reversible). Key via env ESPO_KEY.
const fs = require("fs");
const BASE = "http://127.0.0.1:8085/api/v1";
const KEY = process.env.ESPO_KEY;
const MODE = process.env.MODE || "dry";
const accounts = JSON.parse(fs.readFileSync("/work/.ckshots/accounts.json")).list;
const idByName = {}; accounts.forEach((a) => (idByName[a.name] = a.id));
let emails = [];
for (const f of ["0", "200", "400"]) emails = emails.concat(JSON.parse(fs.readFileSync("/work/.ckshots/em-" + f + ".json")).list);

// curated domain -> action. link=existing account; create=new venue account; b2c=individual buyer;
// trade=cigar intro/partner (special); internal=TH's own contractor; exclude=noise.
const MAP = {
  "shedzug.ch": { act: "link", name: "SHED.Cigar (SHED Club Zug)" },
  "lestroisrois.com": { act: "link", name: "Hotel Les Trois Rois" },
  "burgenstockresort.com": { act: "link", name: "Bürgenstock Resort Lake Luzern Hotel" },
  "burgenstockcollection.com": { act: "link", name: "Bürgenstock Resort Lake Luzern Hotel" },
  "schweizerhofbern.com": { act: "link", name: "Hotel Schweizerhof Bern & SPA" },
  "hotelegerkingen.ch": { act: "link", name: "Hotel Egerkingen AG" },
  "finest-import.ch": { act: "link", name: "Finest Import GmbH" },
  "royalsavoylausanne.com": { act: "create", name: "Royal Savoy Lausanne" },
  "suvrettahouse.ch": { act: "create", name: "Suvretta House" },
  "gostony.ch": { act: "create", name: "Gostony" },
  "bentley-zug.ch": { act: "create", name: "Bentley Zug" },
  "rollingsmoke.ch": { act: "create", name: "Rolling Smoke" },
  "gmail.com": { act: "b2c" }, "gmx.ch": { act: "b2c" }, "bluewin.ch": { act: "b2c" },
  "hotmail.com": { act: "b2c" }, "icloud.com": { act: "b2c" }, "me.com": { act: "b2c" }, "windowslive.com": { act: "b2c" },
  "mirex.gob.do": { act: "trade" }, "mived.gob.do": { act: "trade" }, "corimas.ch": { act: "trade" }, "zaap.ch": { act: "trade" },
  "spinelab.com": { act: "internal" }, "finsy.ch": { act: "internal" }, "finsysolutionsag.onmicrosoft.com": { act: "internal" },
  "svp.ch": { act: "exclude" }, "svp-winterthur.ch": { act: "exclude" }, "immocareag.ch": { act: "exclude" },
  "energie-cluster.ch": { act: "exclude" }, "doc-market.eu": { act: "exclude" }, "google.com": { act: "exclude" },
  "infomaniak.com": { act: "exclude" }, "mail.infomaniak.ch": { act: "exclude" }, "gastronovi.de": { act: "exclude" },
  "jostservice.ch": { act: "exclude" }, "ckitsolutions.ch": { act: "exclude" },
};
const isOurs = (a) => /treshermanos|divinocigars/i.test(a);
function parties(e) {
  const out = [];
  [["from", e.fromString, e.fromName], ["to", e.to, null]].forEach(([dir, s]) => String(s || "").split(";").forEach((a) => {
    const m = a.toLowerCase().match(/([a-z0-9._%+\-]+)@([a-z0-9.\-]+)/);
    if (m && !isOurs(m[0])) out.push({ dir, email: m[0], domain: m[2] });
  }));
  return out;
}
const linkPlan = {}; // domain -> {act,name,emailIds:Set, people:Map(email->name)}
const unmapped = {};
emails.forEach((e) => {
  const ps = parties(e);
  if (!ps.length) return;
  const d = ps[0].domain;
  const rule = MAP[d];
  if (!rule) { unmapped[d] = (unmapped[d] || 0) + 1; return; }
  if (!linkPlan[d]) linkPlan[d] = { ...rule, emailIds: new Set(), people: new Map() };
  linkPlan[d].emailIds.add(e.id);
  // capture the external person from an inbound email (has a real fromName)
  const fromP = ps.find((p) => p.dir === "from");
  if (fromP && e.fromName && !linkPlan[d].people.has(fromP.email)) linkPlan[d].people.set(fromP.email, e.fromName);
});

// summary
const groups = { link: [], create: [], b2c: [], trade: [], internal: [], exclude: [] };
Object.entries(linkPlan).forEach(([d, p]) => groups[p.act].push({ d, name: p.name, emails: p.emailIds.size, people: p.people.size }));
function show(act) {
  const g = groups[act].sort((a, b) => b.emails - a.emails);
  const em = g.reduce((s, x) => s + x.emails, 0), pe = g.reduce((s, x) => s + x.people, 0);
  console.log(`\n## ${act.toUpperCase()}  (${g.length} domains, ${em} emails, ${pe} people)`);
  g.forEach((x) => console.log(`   ${x.d}  ->  ${x.name || (act === "b2c" ? "(individual buyer)" : act)}   [${x.emails} emails, ${x.people} people]`));
}
["link", "create", "b2c", "trade", "internal", "exclude"].forEach(show);
console.log("\n## UNMAPPED (need a decision):");
Object.entries(unmapped).sort((a, b) => b[1] - a[1]).forEach(([d, c]) => console.log(`   ${d}: ${c}`));

// ---- APPLY (existing-account links + their contacts) ----
async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "X-Api-Key": KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(method + " " + path + " -> " + r.status + " " + (await r.text()).slice(0, 120));
  return r.json();
}
(async () => {
  if (MODE !== "apply-existing") { console.log("\n(dry-run only; set MODE=apply-existing to apply the LINK group)"); return; }
  let linked = 0, contacts = 0;
  for (const [d, p] of Object.entries(linkPlan)) {
    if (p.act !== "link") continue;
    const accId = idByName[p.name];
    if (!accId) { console.log("MISSING account: " + p.name); continue; }
    for (const eid of p.emailIds) { await api("PUT", "/Email/" + eid, { parentType: "Account", parentId: accId }); linked++; }
    for (const [email, fullName] of p.people) {
      const parts = fullName.trim().split(/\s+/); const last = parts.length > 1 ? parts.pop() : "(unknown)"; const first = parts.join(" ");
      // dedupe: skip if a contact with this email already exists
      const ex = await api("GET", "/Contact?where[0][type]=equals&where[0][attribute]=emailAddress&where[0][value]=" + encodeURIComponent(email) + "&maxSize=1");
      if (ex.total > 0) continue;
      await api("POST", "/Contact", { firstName: first, lastName: last, emailAddress: email, accountId: accId }); contacts++;
    }
  }
  console.log(`\nAPPLIED: linked ${linked} emails, created ${contacts} contacts.`);
})();
