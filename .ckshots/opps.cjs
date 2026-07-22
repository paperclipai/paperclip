// Build the Opportunities pipeline from each account's linked email threads.
// Stage from a transparent keyword heuristic (reviewable, not an LLM call). One Opportunity per
// account that has threads. MODE=dryopp (default) prints; MODE=apply-opp writes. Key via ESPO_KEY.
const fs = require("fs");
const BASE = "http://127.0.0.1:8085/api/v1";
const KEY = process.env.ESPO_KEY;
const MODE = process.env.MODE || "dryopp";
const all = JSON.parse(fs.readFileSync("/work/.ckshots/elink.json"));
const acc = all.filter((e) => e.parentType === "Account");

const groups = {}; // accId -> {name, emails:[]}
acc.forEach((e) => { (groups[e.parentId] = groups[e.parentId] || { name: e.parentName, emails: [] }).emails.push(e); });

const ORDER = /bestell|\border\b|rechnung|invoice|inventur|lieferung|artikel|zigarren bestell/i;
const PROP = /preisliste|price list|preis liste|muster|sample|pr[äa]sentation|presentation|offerte|angebot|degustation|price/i;
const INTRO = /introduction|vorstellung|kennenlernen|anfrage|collaboration|zusammenarbeit|interesse|partnership/i;
const PROB = { "Closed Won": 100, "Negotiation": 80, "Proposal": 50, "Qualification": 20, "Prospecting": 10 };

function assess(g) {
  const blob = g.emails.map((e) => (e.name || "") + " " + (e.bodyPlain || "")).join(" \n ");
  const orderEmails = g.emails.filter((e) => ORDER.test(e.name || "")).length;
  const has = (re) => re.test(blob);
  let stage, why;
  if (has(ORDER)) { stage = "Closed Won"; why = orderEmails >= 2 ? `recurring orders (${orderEmails} order emails)` : "order placed"; }
  else if (has(PROP)) { stage = "Proposal"; why = "price list / samples / presentation exchanged"; }
  else if (has(INTRO)) { stage = "Qualification"; why = "intro / interest, no offer yet"; }
  else { stage = "Prospecting"; why = "early contact"; }
  const dates = g.emails.map((e) => e.dateSent).filter(Boolean).sort();
  return { stage, why, orderEmails, recurring: orderEmails >= 2, count: g.emails.length, last: (dates[dates.length - 1] || "").slice(0, 10), first: (dates[0] || "").slice(0, 10) };
}

const rows = Object.entries(groups).map(([id, g]) => ({ id, name: g.name, ...assess(g) }))
  .sort((a, b) => (PROB[b.stage] - PROB[a.stage]) || (b.count - a.count));

console.log("Proposed Opportunities (one per account):\n");
console.log("STAGE".padEnd(14), "EMAILS", " ", "LAST".padEnd(11), "ACCOUNT");
rows.forEach((r) => console.log(`${r.stage.padEnd(14)} ${String(r.count).padStart(5)}   ${r.last.padEnd(11)} ${r.name}${r.recurring ? "  ⟳recurring" : ""}   — ${r.why}`));
const byStage = {}; rows.forEach((r) => byStage[r.stage] = (byStage[r.stage] || 0) + 1);
console.log("\nstage counts:", JSON.stringify(byStage), " total:", rows.length);

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "X-Api-Key": KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(method + " " + path + " -> " + r.status + " " + (await r.text()).slice(0, 100));
  return r.json();
}
(async () => {
  if (MODE !== "apply-opp") { console.log("\n(dry-run; set MODE=apply-opp to write. Amounts left blank — not fabricated.)"); return; }
  let made = 0;
  for (const r of rows) {
    // skip if this account already has an opportunity
    const ex = await api("GET", "/Opportunity?where[0][type]=equals&where[0][attribute]=accountId&where[0][value]=" + r.id + "&maxSize=1");
    if (ex.total > 0) continue;
    await api("POST", "/Opportunity", {
      name: r.name + " — TH Cigars",
      accountId: r.id,
      stage: r.stage,
      probability: PROB[r.stage],
      closeDate: r.last || null,
      leadSource: r.stage === "Closed Won" ? "Existing Customer" : "Email",
      description: `Auto-built from ${r.count} mail thread(s) (${r.first}–${r.last}). Heuristic: ${r.why}.${r.recurring ? " Recurring customer." : ""} Amount TBD — review.`,
    });
    made++;
  }
  console.log(`\nAPPLIED: created ${made} opportunities.`);
})();
