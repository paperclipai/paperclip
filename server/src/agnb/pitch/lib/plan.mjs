// Resolve which slide blocks to include from answers + slide-plan.json rules.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(
  readFileSync(join(__dir, "..", "content", "slide-plan.json"), "utf8")
);

export function resolveSlides(answers) {
  const order = [
    "title", "problem", "solution", "how_it_works", "roi", "demo",
    "capabilities", "dashboard", "integrations", "compliance", "proof",
    "market", "traction", "results", "objections", "pricing", "cta"
  ];

  const set = new Set(plan.always);
  for (const b of plan.byClientType[answers.clientType] || []) set.add(b);

  const len = plan.byLength[answers.length];
  if (len?.add) for (const b of len.add) set.add(b);
  if (len?.drop) for (const b of len.drop) set.delete(b);

  return order
    .filter((id) => set.has(id))
    .map((id) => ({ id, ...plan.blocks[id] }));
}

export { plan };
