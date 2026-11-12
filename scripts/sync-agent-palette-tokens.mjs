import fs from "node:fs";
import { fileURLToPath } from "node:url";
const css = fs.readFileSync(new URL("../ui/src/index.css", import.meta.url), "utf8");
const values = {};
for (const [, name, channel, color] of css.matchAll(/--agent-cap-v1-([a-z-]+)-(a|b):\s*(#[0-9a-f]{6});/g)) {
  (values[name] ??= {})[channel] = color;
}
if (Object.keys(values).length !== 18 || Object.values(values).some(v => !v.a || !v.b)) throw new Error("Incomplete cap-v1 palette tokens");
const output = "// Generated from ui/src/index.css by scripts/sync-agent-palette-tokens.mjs.\nexport const CAP_V1_COLORS = " + JSON.stringify(values, null, 2) + " as const;\n";
const target = new URL("../packages/shared/src/cliplab/palette-tokens.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (fs.readFileSync(target, "utf8") !== output) throw new Error("Run node scripts/sync-agent-palette-tokens.mjs");
} else fs.writeFileSync(target, output);
