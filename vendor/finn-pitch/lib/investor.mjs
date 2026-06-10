// Build the Finn INVESTOR deck from data/finn-company.json.
// Embeds real product UI (snaps) + hero photos via /asset & /snaps URLs, so
// VIEW THROUGH THE SERVER: npm run ui  ->  http://localhost:4321/dist/finn-investor.html
//   node lib/investor.mjs   ->  dist/finn-investor.html
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cropFor } from "./snaps.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const LOGOTYPE = readFileSync(join(root, "assets", "brand", "finn-logotype.svg"), "utf8");
const C = JSON.parse(readFileSync(join(root, "data", "finn-company.json"), "utf8"));

// ---- small builders ----------------------------------------------------
const eyebrow = (t) => `<div class="eyebrow">${esc(t)}</div>`;
const draft = `<div class="draft">DRAFT · placeholder data</div>`;
// Real product-UI screenshot (served from /snaps by server.mjs)
function snap(file) {
  const { frameW, frameH } = cropFor(file);
  return `<div class="snap" style="width:${frameW}px;height:${frameH}px;">
    <iframe style="width:${frameW}px;height:${frameH}px;" src="/snaps/${file}" scrolling="no" loading="lazy"></iframe>
  </div>`;
}
const heroPhoto = (name) => `<div class="hero-photo" style="background-image:url('/asset/industry-hero/${name}.jpg')"></div>`;

function bigBars(m) {
  // TAM > SAM > SOM ascending bars (visual heights, not to scale)
  const cols = [
    { v: m.som, label: m.somLabel, h: 30, cls: "som" },
    { v: m.sam, label: m.samLabel, h: 62, cls: "sam" },
    { v: m.tam, label: "Global Contact Center Market, 2025", h: 100, cls: "tam" },
  ];
  return `<div class="bars">${cols.map((c) => `
    <div class="bar-col">
      <div class="bar-cap"><b>${["SOM","SAM","TAM"][["som","sam","tam"].indexOf(c.cls)]} ${esc(c.v)}</b><span>${esc(c.label)}</span></div>
      <div class="bar ${c.cls}" style="height:${c.h}%"></div>
    </div>`).join("")}</div>`;
}

// ---- slides -------------------------------------------------------------
const slides = [];

// 1 · TITLE
slides.push(`<section><div class="s title">
  <div class="title-left">
    <div class="logotype">${LOGOTYPE}</div>
    <h1>Finn turns customer data into <span class="accent">completed phone workflows.</span></h1>
    <div class="subhead">${esc(C.oneLiner)}</div>
    <div class="tchips">
      <span class="tchip"><b>Wedge</b> ${esc(C.thesis.wedge)}</span>
      <span class="tchip"><b>Category</b> ${esc(C.thesis.category)}</span>
      <span class="tchip"><b>Promise</b> ${esc(C.thesis.promise)}</span>
    </div>
    <div class="title-foot">${esc(C.raise.round)} round · raising ${esc(C.raise.amount)} · ${esc(C.raise.valuationOrCap)}</div>
  </div>
  ${heroPhoto("customer-service")}
</div></section>`);

// 2 · PROBLEM — structural gap + the acute pain in one
{
  const g = C.structuralGap;
  const col = (c) => `<div class="gap-col"><div class="gap-h">${esc(c.title)}</div><div class="gap-sub">${esc(c.sub)}</div><ul>${c.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`;
  slides.push(`<section><div class="s full">
    ${eyebrow("the problem")}
    <h2>${esc(g.headline)}</h2>
    <div class="subhead">${esc(g.sub)}</div>
    <div class="gap">
      ${col(g.record)}
      <div class="gap-mid">${esc(g.gap)}</div>
      ${col(g.action)}
    </div>
    <div class="painstrip">
      ${C.problem.points.map((p) => { const [h, ...rr] = p.split(" — "); return `<div class="pain"><b>${esc(h)}</b> ${esc(rr.join(" — "))}</div>`; }).join("")}
    </div>
  </div></section>`);
}

// 3 · WHY NOW — split w/ concurrent-orchestration snap
slides.push(`<section><div class="s split">
  <div class="sp-text">
    ${eyebrow("why now")}
    <h2>Voice AI crossed from demo to <span class="accent">production utility.</span></h2>
    <p class="lede">${esc(C.whyNow)}</p>
    <div class="statline">
      <div class="sl"><b>27.3%</b><span>enterprises using AI in customer service</span></div>
      <div class="sl"><b>&lt;5%</b><span>running live voice agents</span></div>
      <div class="sl"><b>34.8%</b><span>Voice AI market CAGR</span></div>
    </div>
  </div>
  ${snap("multi-agent.html")}
</div></section>`);

// 4 · SOLUTION — split w/ live voice-loop snap
slides.push(`<section><div class="s split">
  <div class="sp-text">
    ${eyebrow("the solution")}
    <h2>One <span class="accent">orchestration layer</span> between every call and your systems.</h2>
    <div class="tiles tiles-2">
      <div class="tile"><b>Reason</b>Understands intent across a full live conversation — not one turn.</div>
      <div class="tile"><b>Act</b>Calls your tools, books, charges, escalates — mid-call.</div>
      <div class="tile"><b>Write back</b>Closes the loop in CRM, helpdesk, billing. Outcomes, not transcripts.</div>
      <div class="tile"><b>Scale</b>Thousands of concurrent calls. Reliable, outcome-measured.</div>
    </div>
  </div>
  ${snap("voice-loop.html")}
</div></section>`);

// 5 · HOW IT WORKS + live product — Build/Deploy/Analyze | dashboard snap
slides.push(`<section><div class="s split hiw">
  <div class="sp-text">
    ${eyebrow("how it works")}
    <h2>The ${esc(C.tech.name)}</h2>
    <div class="vsteps">
      <div class="vstep"><b>Build</b> Design the agent — persona, prompt, knowledge base, call flow — no-code.</div>
      <div class="vstep"><b>Deploy</b> Attach a number, point at an inbound line or outbound audience, go live.</div>
      <div class="vstep"><b>Analyze</b> Every call transcribed, sentiment-scored, searchable — outcomes on one dashboard.</div>
    </div>
    <div class="techbar techbar-col">
      <span><b>Engine</b> ${esc(C.tech.stack)}</span>
      <span><b>Latency</b> ${esc(C.tech.latency)}</span>
      <span><b>Scale</b> ${esc(C.tech.scale)}</span>
      <span><b>Trust</b> ${esc(C.tech.compliance)}</span>
    </div>
  </div>
  ${snap("dashboard-performance.html")}
</div></section>`);

// 5c · PRODUCT FLOW — Ingest/Plan/Engage/Transact/Update/Improve
{
  const pf = C.productFlow;
  slides.push(`<section><div class="s full">
    ${eyebrow("product experience")}
    <h2>${esc(pf.headline)}</h2>
    <div class="subhead">${esc(pf.sub)}</div>
    <div class="flow">
      ${pf.steps.map((s, i) => `<div class="fstep"><div class="fnum">${i + 1}</div><b>${esc(s.n)}</b><span>${esc(s.d)}</span></div>`).join("")}
    </div>
    <div class="flowrows">
      ${pf.rows.map((r) => `<div class="frow"><b>${esc(r.k)}</b> ${esc(r.v)}</div>`).join("")}
    </div>
  </div></section>`);
}

// 6 · MARKET
slides.push(`<section><div class="s market">
  <div class="mk-left">
    ${eyebrow("market opportunity")}
    <h2>${esc(C.market.framing)}</h2>
    <ul class="mkbul">
      ${C.market.segments.map((g) => `<li><b>${esc(g.name)}:</b> ${esc(g.from)} → ${esc(g.to)} at ${esc(g.cagr)} CAGR<span>— ${esc(g.note)}</span></li>`).join("")}
      <li><b>Contact-Center AI Adoption:</b> ${esc(C.market.adoption)}</li>
    </ul>
  </div>
  <div class="mk-right">${bigBars(C.market)}</div>
</div></section>`);

// 6b · BEACHHEAD — sits next to market (where to win)
slides.push(`<section><div class="s split">
  <div class="bh-card">
    <div class="bh-tag">recommended wedge</div>
    <div class="bh-vert">${esc(C.beachhead.vertical)}</div>
    <p>${esc(C.beachhead.why)}</p>
    <div class="bh-wf">${C.beachhead.workflows.map((w) => `<span>${esc(w)}</span>`).join("")}</div>
    <div class="bh-alt">${esc(C.beachhead.altWedges)}</div>
  </div>
  <div class="sp-text">
    ${eyebrow("beachhead")}
    <h2>Start where phone workflows are frequent, repetitive & <span class="accent">revenue-linked.</span></h2>
    <ul class="big">
      ${C.beachhead.criteria.map((c) => { const [h, ...r] = c.split(" — "); return `<li><b>${esc(h)}</b> — ${esc(r.join(" — "))}</li>`; }).join("")}
    </ul>
  </div>
</div></section>`);

// 7 · TRACTION — real KPIs + honest revenue bridge + attributed outcomes
const t = C.traction;
slides.push(`<section><div class="s full">
  ${eyebrow("traction")}
  <h2>${esc(t.headline)}</h2>
  <div class="kpirow">
    <div class="kpi"><div class="kv">${esc(t.mrr)}</div><div class="kl">MRR</div></div>
    <div class="kpi"><div class="kv">${esc(t.arr)}</div><div class="kl">ARR run-rate</div></div>
    <div class="kpi"><div class="kv">${esc(t.callsPerMonth.split(" ")[0])}</div><div class="kl">calls / mo · live</div></div>
    <div class="kpi"><div class="kv">${esc(t.customers.split(" ")[0])}</div><div class="kl">live deployments</div></div>
  </div>
  <div class="kpinote">${esc(t.bridge)} · ${esc(t.pilotsOrLOIs)}</div>
  <div class="outcomes">
    ${t.outcomeMetrics.map((o) => `<span class="oc">${esc(o)}</span>`).join("")}
  </div>
  <div class="tlogos">Live with ${C.traction.logos.map((l) => `<b>${esc(l)}</b>`).join(" · ")}</div>
</div></section>`);

// 8 · PROOF
slides.push(`<section><div class="s full">
  ${eyebrow("proof")}
  <h2>Operators trust Finn with their front line.</h2>
  <div class="quotes">
    ${C.proof.map((q) => `<div class="qcard">${q.csat ? `<div class="stars">★★★★★ <span>CSAT ${esc(q.csat)}</span></div>` : `<div class="stars">★★★★★</div>`}<blockquote>“${esc(q.quote)}”</blockquote><div class="qby">${esc(q.author)}<span>${esc(q.role)}</span></div></div>`).join("")}
  </div>
</div></section>`);

// 9 · BUSINESS MODEL — wallet pricing + path-to-outcome ladder
slides.push(`<section><div class="s split bmsplit">
  <div class="bm-left">
    ${eyebrow("business model")}
    <h2>A path to <span class="accent">outcome pricing.</span></h2>
    <h3 class="psub">${esc(C.pricing.model)}.</h3>
    <div class="ptable">
      <div class="prow phead"><span>Plan</span><span>Per AI credit</span><span>Concurrency</span></div>
      ${C.pricing.tiers.map((p) => `<div class="prow"><span><b>${esc(p.plan)}</b></span><span>${esc(p.rate)}</span><span>${esc(p.concurrent)}</span></div>`).join("")}
    </div>
    <div class="pmodel">
      <span><b>${esc(C.unitEconomics.grossMarginPct)}%</b> gross margin · <b>${esc(t.netRevenueRetention)}</b> NRR · land-and-expand</span>
      <span class="pilot">${esc(C.pricing.pilot)}</span>
    </div>
  </div>
  <div class="ladder">
    ${C.pricing.stages.map((s, i) => `<div class="lstep${i === C.pricing.stages.length - 1 ? " lproof" : ""}"><div class="lstage">${esc(s.stage)}</div><b>${esc(s.pkg)}</b><span>${esc(s.prove)}</span></div>`).join("")}
  </div>
</div></section>`);

// 10 · COMPETITION — full-width matrix
slides.push(`<section><div class="s full">
  ${eyebrow("competition")}
  <h2>Not another voice agent. <span class="accent">The workflow execution layer.</span></h2>
  <div class="cmatrix">
    <div class="crow chead"><span>Category</span><span>What they sell</span><span>Why Finn wins</span></div>
    ${C.competition.matrix.map((m) => `<div class="crow"><span><b>${esc(m.category)}</b></span><span>${esc(m.sells)}</span><span>${esc(m.edge)}</span></div>`).join("")}
  </div>
</div></section>`);

// 10b · MOAT — workflow flywheel around a center hub
{
  const fw = C.competition.flywheel;
  const cell = (f) => `<div class="fw">${esc(f)}</div>`;
  slides.push(`<section><div class="s full">
    ${eyebrow("moat")}
    <h2>${esc(C.competition.moatTagline)}</h2>
    <div class="flywheel">
      <div class="fw-col">${fw.slice(0, 3).map(cell).join("")}</div>
      <div class="fw-hub">Workflow<br>flywheel</div>
      <div class="fw-col">${fw.slice(3, 6).map(cell).join("")}</div>
    </div>
    <div class="fw-foot">The data, controls, integrations & repeatable workflow machinery required to safely complete calls in production.</div>
  </div></section>`);
}

// 11 · TEAM
slides.push(`<section><div class="s teamslide">
  <div class="tm-left">
    ${eyebrow("meet the founder")}
    <h2>Reinventing the last mile of customer conversations.</h2>
    <div class="founder">
      <div class="fname">${esc(C.team.founders[0].name)}</div>
      <div class="frole">${esc(C.team.founders[0].role)}</div>
      <div class="fcred">${esc(C.team.founders[0].cred)}</div>
    </div>
    <div class="teamsize">${esc(C.team.headcount)} — ${esc(C.team.composition)} · ${esc(C.hq)}</div>
  </div>
  <div class="journey">
    ${C.team.journey.map((j) => `<div class="jstep"><b>${esc(j.stage)} — ${esc(j.title)}</b><span>${esc(j.detail)}</span></div>`).join("")}
  </div>
</div></section>`);

// 11 · THE ASK — milestone-tied
const r = C.raise;
slides.push(`<section><div class="s asksplit">
  <div class="ask-left">
    ${eyebrow("the ask")}
    <h2>The round buys <span class="accent">de-risking, not buzzwords.</span></h2>
    <div class="raisebig">Raising ${esc(r.amount)} · ${esc(r.instrument)} · ${esc(r.valuationOrCap)}</div>
    <div class="use">
      ${r.useOfFunds.map((u) => `<div class="ubar"><div class="upct">${esc(u.pct)}%</div><div class="ubucket"><b>${esc(u.bucket)}</b><span>${esc(u.detail)}</span></div></div>`).join("")}
    </div>
  </div>
  <div class="milestones">
    <div class="ms-h">Capital takes us to <span class="msdraft">(18-month targets)</span></div>
    ${r.milestones.map((m) => `<div class="ms">${esc(m)}</div>`).join("")}
    <div class="ask-foot">${esc(r.timeline)}</div>
  </div>
</div></section>`);

// 12 · VISION — split w/ hero
slides.push(`<section><div class="s vsplit">
  <div class="vis-left">
    ${eyebrow("vision")}
    <h2 class="big-vision">${esc(C.visionHeadline)}</h2>
    <div class="subhead vsub">${esc(C.vision)}</div>
    <div class="logotype small">${LOGOTYPE}</div>
  </div>
  ${heroPhoto("saas")}
</div></section>`);

// ---- CSS ----------------------------------------------------------------
const css = `
:root{ --bg:#F6F3EC; --surface:#fff; --ink:#1D1F20; --muted:#737373; --border:#E6E1D6;
  --moss:#435E35; --moss-soft:#d6efd9; --moss-on-soft:#1f5132; --peach:#FDB87A; --pink:#FD7FAD; }
.reveal{ font-family:"Inter",system-ui,sans-serif; color:var(--ink); font-size:24px; background:var(--bg); }
.reveal .backgrounds{ background:var(--bg); }
.reveal .slides section{ text-align:left; top:0!important; height:100%; overflow:hidden; }
/* subtle background depth — faint circles like the reference deck */
.reveal .slides section::before{ content:""; position:absolute; width:620px; height:620px; border-radius:50%; top:-240px; right:-160px; background:radial-gradient(circle, rgba(67,94,53,0.05), rgba(67,94,53,0) 70%); z-index:0; pointer-events:none; }
.reveal .slides section::after{ content:""; position:absolute; width:520px; height:520px; border-radius:50%; bottom:-220px; left:-140px; background:radial-gradient(circle, rgba(253,184,122,0.07), rgba(253,184,122,0) 70%); z-index:0; pointer-events:none; }
.reveal h1,.reveal h2{ font-weight:800; line-height:1.05; letter-spacing:-0.035em; margin:0; }
.reveal h1{ font-size:2.3em; }
.reveal h2{ font-size:1.8em; }
.reveal .accent{ font-family:"Playfair Display",Georgia,serif; font-style:italic; font-weight:600; color:var(--moss); }
.s{ height:100%; box-sizing:border-box; padding:6% 7%; display:flex; flex-direction:column; justify-content:center; position:relative; z-index:1; }
/* slide footer — brand continuity */
.s::after{ content:"Finn · Confidential"; position:absolute; left:7%; bottom:3.4%; font-size:0.42em; font-weight:600; letter-spacing:0.04em; color:var(--muted); opacity:0.7; }
.s.title::after, .s.vsplit::after{ content:""; }
.eyebrow{ color:var(--moss); font-weight:700; font-size:0.62em; letter-spacing:0.04em; margin-bottom:0.7em; }
.draft{ position:absolute; top:5%; right:6%; background:var(--peach); color:#5a3000; font-size:0.42em; font-weight:700; padding:0.3em 0.8em; border-radius:999px; letter-spacing:0.03em; }
.lede{ font-size:0.95em; color:#3a3f45; max-width:24em; margin-top:0.6em; line-height:1.45; }
ul.big{ list-style:none; padding:0; margin-top:1.1em; }
ul.big li{ font-size:0.82em; line-height:1.4; margin:0.6em 0; padding-left:1.2em; position:relative; max-width:26em; }
ul.big li::before{ content:""; position:absolute; left:0; top:0.5em; width:0.55em; height:0.55em; border-radius:3px; background:linear-gradient(135deg,var(--peach),var(--pink)); }
ul.big b{ color:var(--ink); }

/* title */
.s.title{ display:grid; grid-template-columns:1.25fr 0.75fr; gap:4%; align-items:center; padding:6%; }
.title-left{ align-self:center; }
.logotype{ width:150px; margin-bottom:1.4em; } .logotype svg{ width:100%; height:auto; color:var(--ink); }
.logotype.small{ width:120px; margin-top:1.4em; }
.s.title h1{ max-width:14em; }
.title-foot{ margin-top:1.4em; color:var(--muted); font-size:0.72em; font-weight:600; }
.hero-photo{ height:78%; border-radius:20px; background-size:cover; background-position:center; align-self:center; }

/* split layout (text | visual snap) */
.s.split{ display:grid; grid-template-columns:1.02fr 0.98fr; gap:4%; align-items:center; padding:5% 6%; }
.sp-text{ align-self:center; min-width:0; }
.snap{ border-radius:16px; overflow:hidden; border:1px solid var(--border); background:#fff; justify-self:center; align-self:center; box-shadow:0 18px 40px -24px rgba(0,0,0,0.3); transform:scale(0.92); transform-origin:center; }
.snap iframe{ border:0; display:block; }
.tiles.tiles-2{ grid-template-columns:repeat(2,1fr); max-width:24em; }

/* tiles */
.tiles{ display:grid; grid-template-columns:repeat(2,1fr); gap:0.9em; margin-top:1.4em; max-width:30em; }
.tile{ background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:1em 1.1em; font-size:0.66em; line-height:1.4; }
.tile b{ display:block; font-weight:800; margin-bottom:0.3em; font-size:1.15em; color:var(--moss); }

/* steps */
.steps{ display:grid; grid-template-columns:repeat(3,1fr); gap:1.4em; margin-top:1.6em; }
.step{ font-size:0.72em; line-height:1.4; } .step b{ display:block; margin:0.5em 0 0.3em; font-size:1.1em; }
.step .num{ width:1.7em; height:1.7em; border-radius:12px; background:linear-gradient(135deg,var(--peach),var(--pink)); color:#fff; font-weight:800; display:flex; align-items:center; justify-content:center; font-size:1.2em; }

/* why-now statline / vision */
.statline{ display:flex; gap:2.5em; margin-top:1.8em; }
.sl b{ display:block; font-size:2.4em; font-weight:800; letter-spacing:-0.04em; background:linear-gradient(135deg,var(--moss),#6b8f56); -webkit-background-clip:text; background-clip:text; color:transparent; }
.sl span{ color:var(--muted); font-size:0.62em; max-width:9em; display:block; }

/* market */
.s.market{ display:grid; grid-template-columns:1.1fr 0.9fr; gap:3%; align-items:end; padding:6% 6% 7%; }
.mk-left{ align-self:center; }
.mk-left h2{ font-size:1.55em; }
ul.mkbul{ list-style:none; padding:0; margin-top:1em; }
ul.mkbul li{ font-size:0.6em; line-height:1.4; margin:0.5em 0; padding-left:1em; position:relative; }
ul.mkbul li::before{ content:""; position:absolute; left:0; top:0.45em; width:0.45em; height:0.45em; border-radius:50%; background:var(--moss); }
ul.mkbul span{ display:block; color:var(--muted); }
.bars{ display:flex; align-items:flex-end; gap:5%; height:440px; }
.bar-col{ flex:1; display:flex; flex-direction:column; justify-content:flex-end; height:100%; }
.bar-cap{ margin-bottom:0.6em; }
.bar-cap b{ display:block; font-size:0.66em; font-weight:800; color:var(--ink); }
.bar-cap span{ display:block; font-size:0.46em; color:var(--muted); line-height:1.3; margin-top:0.2em; }
.bar{ border-radius:10px 10px 0 0; width:100%; }
.bar.tam{ background:#9cc7a6; } .bar.sam{ background:#5e9e6f; } .bar.som{ background:var(--moss); }

/* traction metrics */
.metrics{ display:grid; grid-template-columns:repeat(3,1fr); gap:1.2em 2em; margin-top:1.6em; max-width:30em; }
.mv{ font-size:1.9em; font-weight:800; letter-spacing:-0.04em; background:linear-gradient(135deg,var(--moss),#6b8f56); -webkit-background-clip:text; background-clip:text; color:transparent; }
.ml{ color:var(--muted); font-size:0.6em; margin-top:0.2em; }

/* problem cards */
.probcards{ display:grid; grid-template-columns:repeat(3,1fr); gap:1em; margin-top:1.5em; }
.pcard{ background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:1.2em 1.3em; }
.pcard b{ display:block; font-size:0.78em; font-weight:800; margin-bottom:0.4em; }
.pcard span{ color:var(--muted); font-size:0.64em; line-height:1.45; }

/* tech bar (how it works) */
.techbar{ display:grid; grid-template-columns:repeat(2,1fr); gap:0.7em 1.6em; margin-top:1.8em; max-width:34em; }
.techbar span{ font-size:0.58em; color:var(--muted); line-height:1.4; }
.techbar b{ color:var(--moss); font-weight:800; margin-right:0.4em; }

/* roi strip */
.roistrip{ display:grid; grid-template-columns:repeat(4,1fr); gap:1.4em; margin-top:1.4em; }
.riv{ font-size:2em; font-weight:800; letter-spacing:-0.04em; background:linear-gradient(135deg,var(--moss),#6b8f56); -webkit-background-clip:text; background-clip:text; color:transparent; }
.ril{ color:var(--muted); font-size:0.56em; margin-top:0.3em; line-height:1.4; }
.outcomes{ display:flex; flex-wrap:wrap; gap:0.6em; margin-top:1.3em; }
.oc{ background:var(--moss-soft); color:var(--moss-on-soft); border-radius:999px; padding:0.4em 0.9em; font-size:0.56em; font-weight:600; }
.oc.ocr{ background:#fdeede; color:#7a4a18; }
.tlogos{ margin-top:1.3em; color:var(--muted); font-size:0.62em; } .tlogos b{ color:var(--ink); } .tlogos i{ font-style:italic; opacity:0.7; }
.kpirow{ display:grid; grid-template-columns:repeat(4,1fr); gap:1.4em; margin-top:1.4em; max-width:34em; }
.kpi .kv{ font-size:2.3em; font-weight:800; letter-spacing:-0.04em; background:linear-gradient(135deg,var(--moss),#6b8f56); -webkit-background-clip:text; background-clip:text; color:transparent; line-height:1; }
.kpi .kl{ color:var(--muted); font-size:0.58em; margin-top:0.35em; }
.kpinote{ margin-top:1em; color:var(--muted); font-size:0.6em; } .kpinote i{ opacity:0.7; }
.teamsize{ margin-top:1em; color:var(--moss); font-weight:700; font-size:0.62em; }

/* proof quotes */
.quotes{ display:grid; grid-template-columns:repeat(3,1fr); gap:1em; margin-top:1.5em; }
.qcard{ background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:1.2em 1.3em; }
.stars{ color:var(--peach); font-size:0.7em; font-weight:700; } .stars span{ color:var(--muted); font-size:0.8em; }
.qcard blockquote{ margin:0.6em 0; font-size:0.6em; line-height:1.5; }
.qby{ font-weight:800; font-size:0.6em; } .qby span{ display:block; color:var(--muted); font-weight:500; }

/* pricing table */
.ptable{ margin-top:1.4em; max-width:30em; border:1px solid var(--border); border-radius:14px; overflow:hidden; }
.prow{ display:grid; grid-template-columns:1fr 1fr 1fr; padding:0.6em 1.2em; font-size:0.64em; border-top:1px solid var(--border); }
.prow.phead{ background:var(--surface); color:var(--muted); font-weight:600; border-top:none; font-size:0.56em; text-transform:uppercase; letter-spacing:0.04em; }
.prow b{ font-weight:800; }
.pmodel{ margin-top:1.2em; font-size:0.62em; color:var(--muted); } .pmodel b{ color:var(--moss); }
.pmodel .pilot{ display:block; margin-top:0.4em; font-style:italic; opacity:0.8; }

/* team / founder journey */
.s.teamslide{ display:grid; grid-template-columns:0.9fr 1.1fr; gap:4%; align-items:center; padding:5% 6%; }
.journey{ display:flex; flex-direction:column; gap:0.7em; }
.jstep{ border-left:2px solid var(--moss-soft); padding:0.1em 0 0.1em 1em; }
.jstep b{ font-size:0.66em; font-weight:800; color:var(--moss); } .jstep span{ display:block; color:var(--muted); font-size:0.56em; line-height:1.4; margin-top:0.2em; }

/* competition */
.vs{ display:grid; grid-template-columns:1fr 1.2fr; gap:1.4em; margin-top:1.5em; max-width:32em; }
.vs-col{ border-radius:16px; padding:1.2em 1.3em; }
.vs-col.them{ background:#efeae0; }
.vs-col.us{ background:var(--moss); color:#fff; }
.vh{ font-weight:800; font-size:0.7em; margin-bottom:0.7em; letter-spacing:0.02em; }
.vs-col.us .vh{ color:var(--peach); }
.vr{ font-size:0.62em; color:var(--muted); margin:0.4em 0; }
.vs-col.us p{ font-size:0.64em; line-height:1.5; margin:0; }

/* team */
.team{ display:flex; gap:2em; margin-top:1.5em; }
.founder{ background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:1.2em 1.3em; min-width:11em; }
.fname{ font-weight:800; font-size:0.85em; } .frole{ color:var(--moss); font-weight:700; font-size:0.6em; margin:0.2em 0 0.6em; }
.fcred{ color:var(--muted); font-size:0.58em; line-height:1.4; }
.team-foot{ margin-top:1.3em; color:var(--muted); font-size:0.62em; }

/* the ask */
.use{ margin-top:1.4em; max-width:30em; }
.ubar{ display:flex; align-items:center; gap:1em; margin:0.55em 0; }
.upct{ font-weight:800; font-size:1.1em; color:var(--moss); width:2.6em; }
.ubucket b{ font-size:0.74em; } .ubucket span{ display:block; color:var(--muted); font-size:0.56em; }
.ask-foot{ margin-top:1.3em; color:var(--muted); font-size:0.64em; font-weight:600; }

/* title thesis chips */
.tchips{ display:flex; gap:0.6em; margin-top:1.2em; flex-wrap:wrap; }
.tchip{ background:var(--surface); border:1px solid var(--border); border-radius:999px; padding:0.4em 0.9em; font-size:0.5em; color:var(--muted); }
.tchip b{ color:var(--moss); font-weight:800; margin-right:0.4em; text-transform:uppercase; letter-spacing:0.03em; }
.reveal .subhead{ color:var(--muted); font-size:0.78em; line-height:1.5; margin-top:0.7em; max-width:24em; }

/* beachhead */
.bh-card{ background:var(--moss); color:#fff; border-radius:20px; padding:1.6em 1.5em; align-self:center; }
.bh-tag{ color:var(--peach); font-size:0.5em; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; }
.bh-vert{ font-size:1.5em; font-weight:800; letter-spacing:-0.03em; margin:0.3em 0 0.5em; }
.bh-card p{ font-size:0.6em; line-height:1.5; opacity:0.85; margin:0; }
.bh-wf{ display:flex; flex-wrap:wrap; gap:0.4em; margin-top:1em; }
.bh-wf span{ background:rgba(255,255,255,0.14); border-radius:999px; padding:0.3em 0.7em; font-size:0.5em; }
.bh-alt{ margin-top:1em; font-size:0.5em; opacity:0.7; line-height:1.4; }

/* business model sub */
.psub{ font-size:0.8em; font-weight:600; color:var(--muted); margin-top:0.4em; }

/* moat flywheel — two columns flanking a center hub */
.flywheel{ display:grid; grid-template-columns:1fr auto 1fr; gap:1.4em; align-items:center; margin-top:1.6em; max-width:42em; }
.fw-col{ display:flex; flex-direction:column; gap:0.7em; }
.fw{ background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:0.8em 1em; font-size:0.6em; font-weight:700; color:var(--moss); text-align:center; }
.fw-hub{ width:5.4em; height:5.4em; border-radius:50%; border:3px solid var(--moss); color:var(--moss); font-weight:800; font-size:0.66em; display:flex; align-items:center; justify-content:center; text-align:center; line-height:1.15; }
.fw-foot{ margin-top:1.3em; color:var(--muted); font-size:0.6em; max-width:34em; line-height:1.5; }

/* ask split + milestones */
.s.asksplit{ display:grid; grid-template-columns:1.05fr 0.95fr; gap:5%; align-items:center; padding:5% 6%; }
.ask-left{ align-self:center; } .s.asksplit .use{ margin-top:1em; }
.raisebig{ margin-top:0.7em; font-weight:800; font-size:0.76em; color:var(--moss); }
.milestones{ background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:1.4em 1.5em; align-self:center; }
.ms-h{ font-size:0.62em; font-weight:800; margin-bottom:0.8em; } .msdraft{ color:var(--peach); font-weight:700; }
.ms{ font-size:0.66em; padding:0.45em 0; border-top:1px solid var(--border); }
.ms:first-of-type{ border-top:none; }
.milestones .ask-foot{ margin-top:1em; }

/* vision */
.s.vision{ align-items:flex-start; }
.big-vision{ font-size:2.6em; max-width:14em; }
.vsub{ margin-top:0.8em; }
.s.vsplit{ display:grid; grid-template-columns:1.1fr 0.9fr; gap:4%; align-items:center; padding:6%; }
.vis-left{ align-self:center; } .s.vsplit .big-vision{ font-size:2.4em; max-width:9em; }

/* 'full' slides vertically centered; footer grounds the bottom */
.s.full{ justify-content:center; padding-bottom:8%; }

/* structural gap */
.gap{ display:grid; grid-template-columns:1fr auto 1fr; gap:1.1em; align-items:center; margin-top:1.3em; }
.gap-col{ background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:1.1em 1.2em; }
.gap-h{ font-weight:800; font-size:0.7em; } .gap-sub{ color:var(--muted); font-size:0.54em; margin:0.2em 0 0.6em; }
.gap-col ul{ list-style:none; padding:0; margin:0; } .gap-col li{ font-size:0.55em; color:var(--muted); margin:0.3em 0; padding-left:0.9em; position:relative; }
.gap-col li::before{ content:""; position:absolute; left:0; top:0.45em; width:0.35em; height:0.35em; border-radius:50%; background:var(--moss); }
/* pain box (peach, on-palette) with connector lines to each side */
.gap-mid{ position:relative; background:#ef8a5c; color:#fff; border-radius:14px; padding:1.2em 1em; font-weight:800; font-size:0.64em; text-align:center; max-width:8em; line-height:1.2; }
.gap-mid::before, .gap-mid::after{ content:""; position:absolute; top:50%; width:1.1em; height:2px; background:var(--border); }
.gap-mid::before{ left:-1.1em; } .gap-mid::after{ right:-1.1em; }
/* acute pain strip under the gap */
.painstrip{ display:grid; grid-template-columns:repeat(3,1fr); gap:0.9em; margin-top:1.1em; }
.pain{ background:#fdeede; border-radius:12px; padding:0.7em 0.9em; font-size:0.56em; line-height:1.4; color:#7a4a18; } .pain b{ display:block; color:#5a3000; font-size:1.05em; margin-bottom:0.15em; }

/* how-it-works vertical steps + column techbar */
.vsteps{ display:flex; flex-direction:column; gap:0.7em; margin-top:1.2em; }
.vstep{ font-size:0.66em; line-height:1.45; padding-left:0.9em; border-left:2px solid var(--moss-soft); } .vstep b{ color:var(--moss); font-weight:800; margin-right:0.4em; }
.techbar.techbar-col{ display:flex; flex-direction:column; gap:0.45em; margin-top:1.3em; max-width:none; }

/* product flow */
.flow{ display:grid; grid-template-columns:repeat(6,1fr); gap:0.7em; margin-top:1.5em; }
.fstep{ background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:0.8em 0.8em; }
.fnum{ width:1.5em; height:1.5em; border-radius:8px; background:linear-gradient(135deg,var(--peach),var(--pink)); color:#fff; font-weight:800; display:flex; align-items:center; justify-content:center; font-size:0.7em; margin-bottom:0.5em; }
.fstep b{ display:block; font-size:0.62em; font-weight:800; margin-bottom:0.25em; } .fstep span{ color:var(--muted); font-size:0.5em; line-height:1.4; }
.flowrows{ display:grid; grid-template-columns:repeat(4,1fr); gap:0.7em; margin-top:1em; }
.frow{ background:var(--moss-soft); color:var(--moss-on-soft); border-radius:10px; padding:0.6em 0.8em; font-size:0.52em; } .frow b{ display:block; font-weight:800; margin-bottom:0.15em; }

/* competition matrix */
.cmatrix{ margin-top:1.4em; border:1px solid var(--border); border-radius:14px; overflow:hidden; }
.crow{ display:grid; grid-template-columns:0.8fr 0.9fr 1.5fr; gap:1em; padding:0.7em 1.2em; border-top:1px solid var(--border); font-size:0.6em; align-items:center; }
.crow.chead{ background:var(--surface); color:var(--muted); border-top:none; font-size:0.52em; text-transform:uppercase; letter-spacing:0.04em; font-weight:600; }
.crow span:last-child{ color:var(--muted); } .crow b{ color:var(--moss); font-weight:800; }

/* business model ladder */
.s.bmsplit{ grid-template-columns:1fr 0.85fr; align-items:center; }
.bm-left{ align-self:center; } .bmsplit .ptable{ max-width:none; }
.ladder{ display:flex; flex-direction:column; gap:0.6em; align-self:center; }
.lstep{ background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:0.7em 1em; border-left:3px solid var(--moss); }
.lstage{ font-size:0.5em; font-weight:800; text-transform:uppercase; letter-spacing:0.04em; color:var(--moss); }
.lstep b{ font-size:0.66em; } .lstep span{ display:block; color:var(--muted); font-size:0.52em; line-height:1.4; margin-top:0.2em; }
.lstep.lproof{ border-left-color:var(--peach); background:#fff7ef; }
`;

// ---- shell --------------------------------------------------------------
const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Finn — Investor Deck</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@1,500;1,600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css">
<style>${css}</style>
</head><body>
<div class="reveal"><div class="slides">
${slides.join("\n")}
</div></div>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"></script>
<script>
const PRINT = location.search.includes("print-pdf");
if (PRINT){ const l=document.createElement("link"); l.rel="stylesheet"; l.href="https://cdn.jsdelivr.net/npm/reveal.js@5/css/print/pdf.css"; document.head.appendChild(l); }
Reveal.initialize({ hash:true, slideNumber: PRINT?false:"c/t", transition:PRINT?"none":"fade", width:1280, height:720, margin:0, center:false, controls:!PRINT });
// Manual browser-print route only (headless --print-to-pdf captures without this):
if (PRINT && location.search.includes("autoprint")) Reveal.on("ready", () => setTimeout(() => window.print(), 1200));
</script>
</body></html>`;

const out = join(root, "dist", "finn-investor.html");
writeFileSync(out, html);
console.log(`✅  Rendered ${out}`);

// ---- PRINT build: static one-page-per-slide for clean 16:9 PDF ----------
const printHtml = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Finn — Investor Deck</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@1,500;1,600&display=swap" rel="stylesheet">
<style>
@page{ size:1280px 720px; margin:0; }
html,body{ margin:0; padding:0; background:#F6F3EC; }
.reveal{ font-family:"Inter",system-ui,sans-serif; font-size:24px; }
.reveal .slides{ width:1280px; overflow:hidden; }
.reveal .slides section{ width:1280px; height:720px; max-height:720px; box-sizing:border-box; overflow:hidden; position:relative; display:block; break-inside:avoid; page-break-inside:avoid; }
.reveal .slides section:not(:last-child){ break-after:page; page-break-after:always; }
${css}
</style>
</head><body>
<div class="reveal"><div class="slides">${slides.join("")}</div></div>
</body></html>`;
const outP = join(root, "dist", "finn-investor-print.html");
writeFileSync(outP, printHtml);
console.log(`✅  Rendered ${outP}`);
