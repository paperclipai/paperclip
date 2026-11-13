import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const schema = JSON.parse(await readFile(new URL("protocol/schemas/provider-failure.schema.json", root), "utf8"));
const properties = schema.properties;
const declarations = Object.entries(properties).map(([key, field]) => {
  const type = "const" in field ? JSON.stringify(field.const)
    : field.enum ? field.enum.map(value => JSON.stringify(value)).join(" | ")
      : field.type === "integer" ? "number" : "string";
  return `  ${key}${schema.required.includes(key) ? "" : "?"}: ${type};`;
}).join("\n");
const generated = `export interface ProviderFailure {\n${declarations}\n}\n\nconst fields = ${JSON.stringify(properties, null, 2)} as const;\n\nexport function readProviderFailure(value: unknown): ProviderFailure | null {\n  try {\n    if (!value || typeof value !== "object" || Array.isArray(value)) return null;\n    const input = value as Record<string, unknown>;\n    const output: Record<string, unknown> = {};\n    for (const [key, field] of Object.entries(fields)) {\n      const item = input[key];\n      if (item === undefined && !${JSON.stringify(schema.required)}.includes(key)) continue;\n      if ("const" in field) {\n        if (item !== field.const) return null;\n      } else if ("enum" in field) {\n        if (typeof item !== "string" || !(field.enum as readonly string[]).includes(item)) return null;\n      } else if (field.type === "integer") {\n        if (typeof item !== "number" || !Number.isInteger(item) || item < field.minimum || item > field.maximum) return null;\n      } else {\n        if (typeof item !== "string") return null;\n        if ("maxLength" in field && ([...item].length < field.minLength || [...item].length > field.maxLength)) return null;\n        if ("pattern" in field && !new RegExp(field.pattern).test(item)) return null;\n        if ("format" in field && !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$/.test(item)) return null;\n        if ("format" in field && !Number.isFinite(Date.parse(item))) return null;\n      }\n      output[key] = item;\n    }\n    return output as unknown as ProviderFailure;\n  } catch { return null; }\n}\n`;
const paths = [new URL("src/contracts/provider-failure.generated.ts", root),
  new URL("../shared/src/provider-failure.generated.ts", root)];
for (const path of paths) {
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8").catch(() => "") !== generated) {
      process.stderr.write(`Provider failure contract is stale: ${fileURLToPath(path)}\n`);
      process.exitCode = 1;
    }
  } else await writeFile(path, generated);
}
