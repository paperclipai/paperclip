// Generate slide copy by shelling out to local Claude CLI (no API key needed).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveSlides } from "./plan.mjs";
import { computeRoi, planForClient } from "./cost-model.mjs";
import {
  matchIndustry, matchPlaybook, pickTestimonial, useCases,
  capabilityStats, planLines
} from "./finn-data.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

function buildContext(answers) {
  const ind = matchIndustry(answers.industry);
  const pb = matchPlaybook(answers.useCase, answers.industry);
  const testi = pickTestimonial(answers.industry);
  const roi = computeRoi({
    monthlyCalls: Number(answers.monthlyCalls) || 5000,
    region: answers.region, planId: answers.planId || planForClient(answers.clientType)
  });
  // matching use-case persona (Lead Qualification, Patient Screening, …)
  const ucKey = Object.keys(useCases).find((k) =>
    k.toLowerCase().includes((answers.useCase || "").replace(/_/g, " ")) ||
    (answers.useCase || "").includes(k.toLowerCase().split(" ")[0]));
  const persona = ucKey ? useCases[ucKey] : null;
  return { ind, pb, testi, roi, persona, stats: capabilityStats(), plans: planLines(answers.region) };
}

function buildPrompt(answers, slides, ctx) {
  const facts = readFileSync(join(root, "data", "facts.md"), "utf8");

  const slideSpec = slides
    .map((s) => `- "${s.id}" (${s.name}): ${s.hint}`)
    .join("\n");

  const real = `REAL FINN DATA — use these EXACT facts/numbers, do not invent alternatives:
- Capability stats: ${ctx.stats.map((s) => `${s.value} ${s.label}`).join(" · ")}
- Matched industry page: ${ctx.ind ? `${ctx.ind.title} — ${ctx.ind.desc}` : "(none — use client's words)"}
- Matched playbook (a real Finn agent template): ${ctx.pb ? `"${ctx.pb.name}" — ${ctx.pb.description || ""} [role: ${ctx.pb.role || "AI agent"}, type: ${ctx.pb.type || ""}]` : "(none)"}
${ctx.persona ? `- Agent persona script for this use case: identity="${ctx.persona.identityText.slice(0, 240)}" beginMessage="${ctx.persona.beginMessage || ""}"` : ""}
- Pricing (region ${answers.region}): ${ctx.plans.map((p) => `${p.name} ${p.rate} (${p.concurrency})`).join(" · ")}
- ROI for ~${ctx.roi.monthlyCalls} calls/mo on ${ctx.roi.planId}: human ${ctx.roi.human.costFmt}/mo (${ctx.roi.perConnectHuman}/connect) vs Finn ${ctx.roi.finn.costFmt}/mo (${ctx.roi.perCallFinn}/call) → ${ctx.roi.savingsPct}% saved, ${ctx.roi.uplift}× connect-rate uplift
- Proof point available: ${ctx.testi ? `${ctx.testi.company}: "${ctx.testi.quote}"` : "(none)"}

For the "demo" slide, build the call around the matched playbook agent (${ctx.pb ? ctx.pb.name : "a Finn agent"}).
For "roi" and "proof" slides write ONLY headline/accent/subhead — numbers + quote are injected automatically.`;

  return `You are the lead copywriter for Finn (hirefinn.ai), an enterprise AI voice-agent platform. You are writing a bespoke pitch deck for ONE specific client. Generic SaaS boilerplate is a failure — every line must feel written for THIS client in THIS industry.

PRODUCT FACTS (only use what is true here, never invent features):
${facts}

${real}

FINN BRAND VOICE — study and match this cadence:
- "Your outbound, inbound, and CRM data. Acting as one."
- "Finn is the enterprise voice orchestration layer. It makes thousands of concurrent calls, reasons through them, extracts data, and updates your systems in real-time. No rework. No idle time."
- "True real-time voice AI is here."
Style rules: short declarative fragments. Confident, not hypey. Em-dash and period-stacking for rhythm ("No rework. No idle time."). Concrete nouns over adjectives. Never say "revolutionary", "cutting-edge", "seamless", "leverage", "unlock", "empower", "game-changer", "in today's fast-paced world". No exclamation marks.

CLIENT BRIEF (use every field — name them, mirror their words):
${JSON.stringify(answers, null, 2)}

PERSONALIZATION REQUIREMENTS (mandatory):
- Name the client ("${answers.clientName}") and their industry ("${answers.industry}") in concrete slides, not just the title.
- Anchor the Problem + Solution + Results to the EXACT use case "${answers.useCase}" and the metric they care about: "${answers.primaryMetric}". Invent plausible industry-specific scenarios (e.g. the kinds of calls, the busy periods, the failure modes that industry actually faces).
- If region is "${answers.region}", reflect it: language coverage, currency, data-residency where relevant.
- If notes are present, weave them in: "${answers.notes || "(none)"}".
- Tone: ${answers.format === "live" ? "sparse — at most 4 bullets per slide, each 5-9 words, a presenter expands on them" : "denser — at most 5 bullets, each one full thought, reads on its own"}.
- Keep it tight: never pair a hero "stat" with more than 3 bullets on the same slide. Subheads are one line, under 16 words.

SLIDES TO WRITE (exactly these ids, in order):
${slideSpec}

THE SIGNATURE MOVE: every slide has an "accent" — a SHORT (2-5 word) Playfair-italic flourish rendered under the headline, the way the brand does "Acting as one." Make it punchy and specific to the slide. Example for a problem slide: "Acting as one." / "Every call answered." / "No more voicemail."

OUTPUT FORMAT — return ONLY valid JSON, no markdown fence, no prose:
{
  "deckTitle": "specific, client-named title — e.g. 'Finn for <Client> — <sharp promise>'",
  "slides": [
    {
      "id": "must match an id above",
      "headline": "short, bold slide title (no period)",
      "accent": "2-5 word Playfair italic flourish",
      "subhead": "one supporting line, or empty string",
      "bullets": ["bullets. For capabilities/how_it_works use 'Label — detail' format so the label can be bolded. [] if none."],
      "stat": { "value": "e.g. 70%", "label": "what it measures, client-specific" },
      "speakerNotes": "1-3 sentences the presenter says out loud"
    }
  ]
}
Use "stat" only where a hero number fits (problem, results, traction). Make stat labels client/industry-specific, not generic. Set "stat" to null otherwise.
NEVER write bracketed placeholders like "[screenshot: ...]", "(image)", "[chart]", or instructions to the reader. Real product screenshots are inserted automatically beside your copy — every bullet must be real, substantive prose the audience reads.
Return the JSON object and nothing else.`;
}

function callClaude(prompt) {
  console.log("🤖  Calling local Claude… (this can take ~30-60s)");
  const raw = execFileSync(
    "claude",
    ["-p", prompt, "--output-format", "json"],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  );
  const envelope = JSON.parse(raw);
  if (envelope.is_error) throw new Error("Claude returned error: " + envelope.result);
  return envelope.result; // the model's text answer
}

function extractJson(text) {
  // strip accidental ```json fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in Claude output:\n" + text);
  return JSON.parse(body.slice(start, end + 1));
}

export async function generate(answers) {
  const slides = resolveSlides(answers);
  console.log(`📝  Planning ${slides.length} slides: ${slides.map((s) => s.id).join(", ")}`);
  const ctx = buildContext(answers);
  const prompt = buildPrompt(answers, slides, ctx);
  const text = callClaude(prompt);
  const deck = extractJson(text);
  deck._answers = answers;
  deck._ctx = { roi: ctx.roi, testimonial: ctx.testi, industry: ctx.ind, playbook: ctx.pb && { name: ctx.pb.name, role: ctx.pb.role } };
  // v1: client-logo scraping disabled (title falls back to the Finn mark).
  // Re-enable by uploading the scraped logo to the asset bucket at gen time.
  return deck;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const answers = JSON.parse(readFileSync(join(root, "answers.json"), "utf8"));
  generate(answers);
}
