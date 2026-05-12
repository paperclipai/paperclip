import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  OAuthProviderConfigSchema,
  type OAuthProviderConfig,
} from "./provider-config.js";
import { logger } from "../middleware/logger.js";

type YamlObject = Record<string, unknown>;

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseScalar(part.trim()));
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseProviderYaml(raw: string): unknown {
  const root: YamlObject = {};
  const stack: Array<{
    indent: number;
    object: YamlObject;
    parent?: YamlObject;
    key?: string;
  }> = [{ indent: -1, object: root }];

  for (const [index, originalLine] of raw.split(/\r?\n/).entries()) {
    if (!originalLine.trim() || originalLine.trimStart().startsWith("#")) {
      continue;
    }
    const leadingWhitespace = originalLine.match(/^\s*/)?.[0] ?? "";
    if (leadingWhitespace.includes("\t")) {
      throw new Error(`Tab indentation is not supported on line ${index + 1}`);
    }
    const indent = leadingWhitespace.length;
    if (indent % 2 !== 0) {
      throw new Error(`Invalid indentation on line ${index + 1}`);
    }
    const line = originalLine.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const current = stack[stack.length - 1]!;

    if (line.startsWith("- ")) {
      if (!current.parent || !current.key) {
        throw new Error(`Unexpected list item on line ${index + 1}`);
      }
      const existing = current.parent[current.key];
      if (!Array.isArray(existing)) {
        current.parent[current.key] = [];
      }
      (current.parent[current.key] as unknown[]).push(
        parseScalar(line.slice(2)),
      );
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error(`Invalid YAML mapping on line ${index + 1}`);
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!value) {
      const child: YamlObject = {};
      current.object[key] = child;
      stack.push({ indent, object: child, parent: current.object, key });
      continue;
    }
    current.object[key] = parseScalar(value);
  }

  return root;
}

/**
 * Load and validate OAuth provider configs from every `*.yaml`/`*.yml` file in
 * a directory. Returns an empty array when the directory does not exist —
 * operators may run Paperclip without any file-based OAuth providers.
 *
 * Throws synchronously on the first invalid file: bad YAML or a config that
 * fails Zod validation. Operators see the offending file in the log and the
 * server refuses to start, which matches the rest of the bootstrap path.
 */
export async function loadProviderConfigsFromDirectory(
  dir: string,
): Promise<OAuthProviderConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const yamlFiles = entries.filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
  );
  const configs: OAuthProviderConfig[] = [];
  for (const file of yamlFiles) {
    const fullPath = path.join(dir, file);
    const raw = await readFile(fullPath, "utf8");
    let parsed: unknown;
    try {
      parsed = parseProviderYaml(raw);
    } catch (err) {
      logger.error(
        { file: fullPath, err },
        "failed to parse OAuth provider yaml",
      );
      throw new Error(`Invalid YAML in ${fullPath}: ${(err as Error).message}`);
    }
    const result = OAuthProviderConfigSchema.safeParse(parsed);
    if (!result.success) {
      logger.error(
        { file: fullPath, issues: result.error.issues },
        "invalid OAuth provider config",
      );
      throw new Error(
        `Invalid provider config in ${fullPath}: ${result.error.message}`,
      );
    }
    configs.push(result.data);
  }
  return configs;
}
