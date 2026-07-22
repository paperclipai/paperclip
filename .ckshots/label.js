const fs = require("fs");
const j = JSON.parse(fs.readFileSync(0, "utf8"));
const rows = Object.entries(j).map(([id, v]) => ({ id, ...v }));
const dom = (r) => ((String(r.from).match(/@([^>]+)/) || [])[1] || "?").toLowerCase().replace(/>$/, "");
const HOSP = ["lestroisrois.com", "burgenstockcollection.com", "burgenstockresort.com", "schweizerhofbern.com", "royalsavoylausanne.com", "shedzug.ch", "gostony.ch", "cbs-home.com", "li-steven.ch"];
const NOISE_DOM = ["google.com", "infomaniak.com", "onmicrosoft.com"];
const isAuto = (r) => /no-?reply|notifications?|noreply|automatic reply|abgesagt|aktualisierte einladung|einladung:|\.ics|google meet|calendar/i.test(r.from + " " + r.subject);
const lang = (r) => { const t = r.subject + " " + r.snippet; if (/estimado|reuni[oó]n|embajador/i.test(t)) return "ES"; if (/\bdear\b|i trust|i hope you are|please find/i.test(t)) return "EN"; if (/bonjour|cordialement|merci\b/i.test(t)) return "FR"; return "DE"; };
function classify(r) {
  const d = dom(r), t = (r.subject + " " + r.snippet).toLowerCase();
  if (NOISE_DOM.includes(d) || isAuto(r)) return { rel: "noise", cat: "automated/internal", intent: "none", lead: "no" };
  if (/android|gemini|doc-market|developer/i.test(t)) return { rel: "noise", cat: "unrelated-pitch", intent: "none", lead: "no" };
  if (d === "bluewin.ch" || d === "gmail.com" || d === "gmx.ch") {
    const cat = /danke|gefallen|geniesst|vielen dank/i.test(t) ? "testimonial/repeat" : "inquiry";
    return { rel: "B2C-buyer", cat, intent: cat === "inquiry" ? "info-request" : "fyi", lead: cat === "inquiry" ? "yes" : "no" };
  }
  if (HOSP.includes(d)) {
    let cat = "partnership", intent = "info-request";
    if (/rechnung|invoice|preis/i.test(t)) { cat = "invoice/pricing"; intent = "complaint"; }
    else if (/muster|sample|price list|preisliste|details|pr[äa]sentation|information/i.test(t)) { cat = "inquiry"; intent = "sample/info-request"; }
    else if (/inventur|artikel|bestell|order|liefer/i.test(t)) { cat = "order/logistics"; intent = "order"; }
    else if (/event|cigar circle|workshop|einladung/i.test(t)) { cat = "event"; intent = "meeting"; }
    else if (/futurelog|e-procurement|onboarding/i.test(t)) { cat = "procurement-onboarding"; intent = "action-required"; }
    return { rel: "B2B-hospitality", cat, intent, lead: ["inquiry", "order/logistics", "invoice/pricing"].includes(cat) ? "yes" : "maybe" };
  }
  if (/embajada|embassy|mirex|embajador/i.test(t)) return { rel: "B2B-intro", cat: "intro/diplomatic", intent: "info-request", lead: "maybe" };
  if (/siglo mundo|distributor|kontakt|referral|reuni[oó]n/i.test(t)) return { rel: "B2B-trade", cat: "intro/referral", intent: "meeting", lead: "maybe" };
  if (/finsy|corimas|grafic|some|jour-fix/i.test(t)) return { rel: "supplier-internal", cat: "contractor", intent: "fyi", lead: "no" };
  return { rel: "other", cat: "uncategorized", intent: "?", lead: "review" };
}
const hdr = ["id", "date", "from_domain", "language", "relationship", "category", "intent", "lead_relevant", "subject"];
const out = [hdr.join("\t")];
const counts = { rel: {}, lead: {} };
rows.sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach((r) => {
  const c = classify(r), L = lang(r);
  counts.rel[c.rel] = (counts.rel[c.rel] || 0) + 1; counts.lead[c.lead] = (counts.lead[c.lead] || 0) + 1;
  out.push([r.id, String(r.date).slice(0, 10), dom(r), L, c.rel, c.cat, c.intent, c.lead, String(r.subject).slice(0, 70).replace(/\t/g, " ")].join("\t"));
});
process.stdout.write(out.join("\n") + "\n");
process.stderr.write("rows: " + rows.length + "\nby relationship: " + JSON.stringify(counts.rel) + "\nlead_relevant: " + JSON.stringify(counts.lead) + "\n");
