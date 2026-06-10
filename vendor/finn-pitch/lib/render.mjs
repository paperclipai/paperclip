// Render slides.json -> dist/<client>.html (reveal.js, Finn brand).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { snapFor, cropFor } from "./snaps.mjs";
import {
  industryHero, allIntegrationLogos, brandAsset
} from "./finn-data.mjs";
import { computeRoi, planForClient } from "./cost-model.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const LOGO = readFileSync(join(root, "assets", "finn-logo.svg"), "utf8");

function heading(tag, s) {
  const acc = s.accent ? `<span class="accent">${esc(s.accent)}</span>` : "";
  return `<${tag}>${esc(s.headline)}${acc}</${tag}>`;
}
function bullets(arr) {
  return arr?.length ? `<ul>${arr.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : "";
}
function labeled(arr, cls) {
  return arr.map((b) => {
    const [h, ...r] = b.split(/ — | – |: /);
    return `<div class="${cls}"><b>${esc(h)}</b>${esc(r.join(" "))}</div>`;
  }).join("");
}
function statBig(s) {
  return s.stat
    ? `<div class="stat"><div class="value">${esc(s.stat.value)}</div><div class="label">${esc(s.stat.label)}</div></div>`
    : "";
}

function shotPanel(file) {
  const { frameW, frameH } = cropFor(file);
  return `<div class="visual shot" style="width:${frameW}px;height:${frameH}px;">
    <iframe class="snap" style="width:${frameW}px;height:${frameH}px;" src="/snaps/${file}" scrolling="no" loading="lazy"></iframe>
  </div>`;
}
function photoPanel(url) {
  return `<div class="visual photo" style="background-image:url('${url}')"></div>`;
}
function brandPanel(s) {
  const inner = s.stat
    ? `<div class="panel-stat"><div class="pv">${esc(s.stat.value)}</div><div class="pl">${esc(s.stat.label)}</div></div>`
    : `<div class="panel-accent">${esc(s.accent || "")}</div>`;
  return `<div class="visual brand"><div class="wave">${LOGO}</div>${inner}</div>`;
}

// ROI comparison card from injected ctx
function roiPanel(roi) {
  if (!roi) return brandPanel({ accent: "The math." });
  return `<div class="visual roi">
    <div class="roi-row">
      <div class="roi-col human"><div class="rl">Human team</div><div class="rv">${esc(roi.human.costFmt)}</div><div class="rs">/mo · ${esc(roi.perConnectHuman)}/connect</div></div>
      <div class="roi-vs">vs</div>
      <div class="roi-col finn"><div class="rl">Finn</div><div class="rv">${esc(roi.finn.costFmt)}</div><div class="rs">/mo · ${esc(roi.perCallFinn)}/call</div></div>
    </div>
    <div class="roi-badges">
      <div class="rb"><b>${esc(roi.savingsFmt)}</b>saved / month</div>
      <div class="rb"><b>${roi.savingsPct}%</b>lower cost</div>
      <div class="rb"><b>${roi.uplift}×</b>connect rate</div>
    </div>
    <div class="roi-foot">Based on ~${roi.monthlyCalls.toLocaleString()} calls/mo</div>
  </div>`;
}

// Proof quote card from injected testimonial
function proofPanel(testi) {
  if (!testi) return brandPanel({ accent: "Real results." });
  return `<div class="visual proof">
    <div class="proof-co">${esc(testi.company)}</div>
    <blockquote>“${esc(testi.quote)}”</blockquote>
    <div class="proof-by">${esc(testi.author)}<span>${esc(testi.role)}</span></div>
  </div>`;
}

function slideHTML(s, deck) {
  const a = deck._answers || {};
  const ctx = deck._ctx || {};
  const client = a.clientName || "";
  const sub = s.subhead ? `<div class="subhead">${esc(s.subhead)}</div>` : "";
  const notes = s.speakerNotes ? `<aside class="notes">${esc(s.speakerNotes)}</aside>` : "";
  const pill = `<div class="pill"><span class="tag">Finn</span> ${esc(s.name || "")}</div>`;
  const logotype = brandAsset("finn-logotype.svg") || brandAsset("finn-logo.svg");
  const footer = `<div class="slide-footer"><span class="fmark">${LOGO}<i>for ${esc(client)}</i></span></div>`;
  const left = (extra = "") => `<div class="col-text fit">${pill}${heading("h2", s)}${sub}${extra}${notes}</div>`;
  const split = (visual, l) => `<section data-id="${s.id}"><div class="layout split">${l}${visual}</div>${footer}</section>`;

  // TITLE — industry photo hero if available, else gradient panel
  if (s.id === "title") {
    const hero = industryHero(a.industry, ctx.industry);
    const visual = hero ? photoPanel(hero)
      : `<div class="visual brand hero"><div class="wave">${LOGO}</div><div class="panel-accent">${esc(s.accent || "")}</div></div>`;
    const finnMark = logotype
      ? `<img class="deck-logo-img" src="${logotype}" alt="Finn">`
      : `<div class="deck-logo">${LOGO}</div>`;
    const brand = deck._clientLogo
      ? `<div class="title-lockup">${finnMark}<span class="lockup-x">×</span><span class="client-logo"><img src="${deck._clientLogo}" alt="${esc(client)}"></span></div>`
      : finnMark;
    return `<section data-id="title"><div class="layout title">
      <div class="hero-left">${brand}${heading("h1", s)}${sub}${notes}</div>${visual}
    </div></section>`;
  }

  // CAPABILITIES — full-width tiles
  if (s.id === "capabilities" && s.bullets?.length) {
    return `<section data-id="capabilities"><div class="layout full fit">
      ${pill}${heading("h2", s)}${sub}<div class="tiles">${labeled(s.bullets, "tile")}</div>${notes}
    </div>${footer}</section>`;
  }

  // HOW IT WORKS — full-width steps
  if (s.id === "how_it_works" && s.bullets?.length >= 3) {
    const steps = s.bullets.slice(0, 3).map((b, n) => {
      const [h, ...r] = b.split(/ — | – |: /);
      return `<div class="step"><div class="num">${n + 1}</div><b>${esc(h)}</b>${esc(r.join(" "))}</div>`;
    }).join("");
    return `<section data-id="how_it_works"><div class="layout full fit">
      ${pill}${heading("h2", s)}${sub}<div class="steps">${steps}</div>${notes}
    </div>${footer}</section>`;
  }

  // INTEGRATIONS — logo grid
  if (s.id === "integrations") {
    const logos = allIntegrationLogos(15);
    const grid = logos.length
      ? `<div class="visual logos"><div class="logo-grid">${logos.map((u) => `<div class="logo-cell"><img src="${u}" alt=""></div>`).join("")}</div></div>`
      : brandPanel(s);
    return split(grid, left());
  }

  // ROI — computed comparison
  if (s.id === "roi") return split(roiPanel(ctx.roi), left());

  // PROOF — real testimonial
  if (s.id === "proof") return split(proofPanel(ctx.testimonial), left());

  // SCREENSHOT slides
  const snap = snapFor(s.id, a);
  if (snap) return split(shotPanel(snap), left(statBig(s) + bullets(s.bullets)));

  // DEFAULT — gradient panel
  return split(brandPanel(s), left(bullets(s.bullets)));
}

export function render(deck) {
  // recompute ROI deterministically so formatting/model fixes apply on re-render
  const a = deck._answers || {};
  deck._ctx = deck._ctx || {};
  deck._ctx.roi = computeRoi({
    monthlyCalls: Number(a.monthlyCalls) || 5000,
    region: a.region, planId: a.planId || planForClient(a.clientType)
  });

  const theme = readFileSync(join(root, "theme", "finn.css"), "utf8");
  const sections = deck.slides.map((s) => slideHTML(s, deck)).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(deck.deckTitle || "Finn Pitch")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@1,500;1,600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css">
<style>
.reveal :where(:root){ --font-playfair: "Playfair Display"; }
${theme}
</style>
</head>
<body>
<div class="reveal"><div class="slides">
${sections}
</div></div>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"></script>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/plugin/notes/notes.js"></script>
<script>
const PRINT = location.search.includes("print-pdf");
if (PRINT) {
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "https://cdn.jsdelivr.net/npm/reveal.js@5/css/print/pdf.css";
  document.head.appendChild(l);
}
Reveal.initialize({ hash: true, slideNumber: PRINT ? false : "c/t", transition: "fade",
  plugins: [ RevealNotes ], width: 1280, height: 720, margin: 0, center: false, controls: !PRINT });
if (PRINT) Reveal.on("ready", () => setTimeout(() => window.print(), 1200));

function fit(){
  document.querySelectorAll(".reveal .fit").forEach(f => {
    f.style.setProperty("--fit-scale","1");
    const box = f.closest("section");
    const avail = (box.querySelector(".layout.full") ? 720-110 : 720-70);
    if(f.scrollHeight > avail) f.style.setProperty("--fit-scale", Math.max(0.58, (avail/f.scrollHeight)).toFixed(3));
  });
}
Reveal.on("ready", () => setTimeout(fit,150));
Reveal.on("slidechanged", () => setTimeout(fit,60));
window.addEventListener("load", () => setTimeout(fit,500));
</script>
</body>
</html>`;

  const safe = (deck._answers?.clientName || "deck").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  writeFileSync(join(root, "dist", `${safe}.json`), JSON.stringify(deck, null, 2));
  const out = join(root, "dist", `${safe}.html`);
  writeFileSync(out, html);
  console.log(`✅  Rendered ${out}`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const deck = JSON.parse(readFileSync(join(root, "slides.json"), "utf8"));
  render(deck);
}
