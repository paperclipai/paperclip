import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// NEO-442 · W5 — Model-echoable rebrand (Bucket G) + naming directive.
//
// Asserts the two base system prompts the model ingests have been
// canonicalized to "Cortex" and carry the D6 naming directive, and that the
// product name "Paperclip" no longer appears as user-facing prose. Internal
// identifiers stay frozen and are therefore excluded from the check:
//   - X-Paperclip-* audit headers (must remain wire-compatible)
//   - the directive's own quoted reference to the forbidden name
//   - lowercase skill/package/provider identifiers (e.g. `name: paperclip-board`)
//     which are handled by W4, not W5.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const D6_DIRECTIVE =
  'This product is called Cortex. Never refer to it as "Paperclip" in user-facing output.';

// The two prompts appended as system prompts at runtime:
//  - board-chat: skills/cortex-board/SKILL.md (loadBoardSkill -> --append-system-prompt)
//  - agent base: server/src/onboarding-assets/default/AGENTS.md
const AGENT_BASE_PROMPT = "server/src/onboarding-assets/default/AGENTS.md";
const BOARD_SYSTEM_PROMPT = "skills/cortex-board/SKILL.md";

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

/** Remove the tokens that are allowed to still contain the string "Paperclip". */
function stripFrozen(text: string): string {
  return text
    .split("\n")
    .filter((line) => line !== D6_DIRECTIVE)
    .join("\n")
    // X-Paperclip-Run-Id / X-Paperclip-Signature / X-Paperclip-Timestamp ...
    .replace(/X-Paperclip-[A-Za-z-]+/g, "");
}

describe("W5 naming directive — model-ingested base prompts", () => {
  for (const rel of [AGENT_BASE_PROMPT, BOARD_SYSTEM_PROMPT]) {
    describe(rel, () => {
      const text = read(rel);

      it("carries the D6 naming directive", () => {
        expect(text).toContain(D6_DIRECTIVE);
      });

      it("refers to the product as Cortex", () => {
        expect(text).toContain("Cortex");
      });

      it("does not echo the product name 'Paperclip' as user-facing prose", () => {
        expect(stripFrozen(text)).not.toMatch(/\bPaperclip\b/);
      });
    });
  }
});
