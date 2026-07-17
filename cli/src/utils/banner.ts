import pc from "picocolors";
import { PRODUCT_NAME } from "@paperclipai/shared";

const TAGLINE = "The app people use to manage AI agents for work";

// Wordmark banner. The final authored CORTEX ASCII glyph art is a W6 deliverable
// (NEO-443, pending Board asset); until it lands we render the product name from
// the single source of truth so the CLI never prints the old brand. Swap the
// body of `renderWordmark` for the authored art without touching call sites.
function renderWordmark(): string[] {
  return [pc.bold(pc.cyan(`  ${PRODUCT_NAME.toUpperCase()}`))];
}

export function printPaperclipCliBanner(): void {
  const lines = [
    "",
    ...renderWordmark(),
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
