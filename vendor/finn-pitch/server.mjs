// Web UI server: form -> generate (local Claude) -> render -> preview.
import express from "express";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { generate } from "./lib/generate.mjs";
import { render } from "./lib/render.mjs";
import { snapFor, ALL_SNAPS } from "./lib/snaps.mjs";
import { inlineHtml } from "./lib/inline.mjs";
import { deckToPdf } from "./lib/pdf.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(__dir, "public")));
app.use("/dist", express.static(join(__dir, "dist")));
app.use("/snaps", express.static(join(__dir, "assets", "snaps")));
app.use("/asset", express.static(join(__dir, "assets")));

const slug = (name) => (name || "deck").toLowerCase().replace(/[^a-z0-9]+/g, "-");

// slides that render a screenshot panel (editable via picker)
function shotSlides(deck) {
  const a = deck._answers || {};
  const skip = new Set(["title", "capabilities", "how_it_works"]);
  return deck.slides
    .filter((s) => !skip.has(s.id))
    .map((s) => ({ id: s.id, name: s.name || s.id, current: snapFor(s.id, a) }))
    .filter((s) => s.current); // only slides that currently show a shot
}

function deckPayload(deck, file) {
  return {
    ok: true, file, slug: slug(deck._answers?.clientName),
    url: `/dist/${file}`, deckTitle: deck.deckTitle,
    slides: deck.slides.map((s) => s.id),
    shots: shotSlides(deck), allSnaps: ALL_SNAPS
  };
}

// list existing decks
app.get("/api/decks", (_req, res) => {
  let files = [];
  try {
    files = readdirSync(join(__dir, "dist"))
      .filter((f) => f.endsWith(".html") && !f.startsWith("_") && !/-(print|standalone)\.html$/.test(f))
      .map((f) => ({ file: f, url: `/dist/${f}`, mtime: statSync(join(__dir, "dist", f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {}
  res.json(files);
});

// generate a new deck (calls local Claude)
app.post("/api/decks", async (req, res) => {
  const answers = req.body || {};
  if (!answers.clientName) return res.status(400).json({ error: "clientName required" });
  try {
    const deck = await generate(answers);
    const file = render(deck).split("/").pop();
    res.json(deckPayload(deck, file));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// re-render an existing deck with screenshot overrides (no Claude, instant)
app.post("/api/rerender", (req, res) => {
  const { slug: s, overrides } = req.body || {};
  const jsonPath = join(__dir, "dist", `${s}.json`);
  if (!s || !existsSync(jsonPath)) return res.status(404).json({ error: "deck not found" });
  try {
    const deck = JSON.parse(readFileSync(jsonPath, "utf8"));
    deck._answers = deck._answers || {};
    deck._answers.snapOverrides = { ...(deck._answers.snapOverrides || {}), ...(overrides || {}) };
    const file = render(deck).split("/").pop();
    res.json(deckPayload(deck, file));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// resolve a requested deck file safely inside dist/
function deckFile(name) {
  const f = basename(name || "");
  if (!f.endsWith(".html")) return null;
  const p = join(__dir, "dist", f);
  return existsSync(p) ? { f, p } : null;
}

// download a self-contained HTML (snaps + assets + reveal inlined, opens anywhere)
app.get("/api/dl/html/:file", (req, res) => {
  const d = deckFile(req.params.file);
  if (!d) return res.status(404).send("not found");
  try {
    const html = inlineHtml(readFileSync(d.p, "utf8"));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${d.f.replace(/\.html$/, "")}.html"`);
    res.send(html);
  } catch (e) { console.error(e); res.status(500).send(e.message); }
});

// download a 16:9 PDF — screenshots each live-rendered slide, then assembles
app.get("/api/dl/pdf/:file", (req, res) => {
  const d = deckFile(req.params.file);
  if (!d) return res.status(404).send("not found");
  const base = d.f.replace(/\.html$/, "");
  try {
    const pdf = deckToPdf(readFileSync(d.p, "utf8"));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error(e);
    res.status(500).send("PDF render failed: " + e.message);
  }
});

const PORT = process.env.PORT || 4321;
app.listen(PORT, () => console.log(`\n🎤  finn-pitch UI → http://localhost:${PORT}\n`));
