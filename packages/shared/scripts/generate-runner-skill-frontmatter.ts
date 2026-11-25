import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createRequire } from "node:module";

const runnerRequire = createRequire(new URL("../../paperclip-runner/package.json", import.meta.url));
const { Ajv } = runnerRequire("ajv");
const standaloneCode = runnerRequire("ajv/dist/standalone").default;
import { skillFrontmatterSchema } from "../src/frontmatter.ts";

// Keep the standalone mock on the production parser and schema without adding
// a runtime dependency on a Paperclip workspace package.
const source = await readFile(new URL("../src/frontmatter.ts", import.meta.url), "utf8");
function section(start: string, end?: string) {
  const from = source.indexOf(start);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  if (from < 0 || to < 0) throw new Error(`Frontmatter source section missing: ${start}`);
  return source.slice(from, to).trim();
}
const ajv = new Ajv({ strict: false, code: { esm: true, source: true, lines: true } });
ajv.addSchema(z.toJSONSchema(skillFrontmatterSchema, { target: "draft-7" }), "skill-frontmatter");
const validator = standaloneCode(ajv, { validateSkillFrontmatter: "skill-frontmatter" })
  .replaceAll('require("ajv/dist/runtime/ucs2length").default', '((value: string) => [...value].length)');
if (/\brequire\(/.test(validator)) throw new Error("Unexpected runtime dependency in the standalone skill validator");
const generated = [
  "// @ts-nocheck -- generated parser and standalone schema validator.",
  "// Generated from packages/shared/src/frontmatter.ts. Do not edit by hand.",
  "// Regenerate: node packages/shared/scripts/generate-runner-skill-frontmatter.ts",
  section("export interface MarkdownDoc", "export interface FrontmatterBlock"),
  section("export function isPlainRecord", "export function asString"),
  section("export function parseFrontmatterMarkdown", "function assertSerializableRecord"),
  section("function parseYamlFrontmatter"),
  validator,
].join("\n\n") + "\n";
const target = new URL("../../paperclip-runner/src/mock-core/skill-frontmatter.generated.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(target, "utf8") !== generated) throw new Error("Runner skill frontmatter contract is stale. Regenerate it.");
} else {
  await writeFile(target, generated);
}
