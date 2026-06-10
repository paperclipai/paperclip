#!/usr/bin/env node
// Orchestrator: intake -> generate (local Claude) -> render -> open
import { execFile } from "node:child_process";
import { runIntake } from "./lib/intake.mjs";
import { generate } from "./lib/generate.mjs";
import { render } from "./lib/render.mjs";

const run = async () => {
  const answers = await runIntake();
  const deck = await generate(answers);
  const out = render(deck);

  console.log("\n🎉  Done. Opening deck…");
  execFile("open", [out], () => {});
  console.log("    Press 'S' in the deck for speaker notes, 'E' to PDF-export.\n");
};

run().catch((e) => {
  console.error("\n❌ ", e.message);
  process.exit(1);
});
