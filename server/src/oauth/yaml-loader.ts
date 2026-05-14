import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  OAuthProviderConfigSchema,
  type OAuthProviderConfig,
} from "./provider-config.js";
import { logger } from "../middleware/logger.js";

type YamlContainer = Record<string, unknown> | unknown[];

interface StackEntry {
  indent: number;
  value: YamlContainer;
}

function parseScalar(value: string): unknown {
  if (value === "[]") return [];
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item.trim()));
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function nextMeaningfulLine(lines: string[], start: number): string | undefined {
  for (let i = start; i < lines.length; i += 1) {
    const trimmed = lines[i]?.trim();
    if (trimmed && !trimmed.startsWith("#")) return trimmed;
  }
  return undefined;
}

function parseProviderYaml(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: StackEntry[] = [{ indent: -1, value: root }];
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  lines.forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    if (line.includes("\t")) {
      throw new Error(`Tabs are not supported at line ${index + 1}`);
    }

    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]!.value;

    if (content.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error(`Unexpected list item at line ${index + 1}`);
      }
      parent.push(parseScalar(content.slice(2).trim()));
      return;
    }

    if (Array.isArray(parent)) {
      throw new Error(`Unexpected mapping entry in list at line ${index + 1}`);
    }

    const separator = content.indexOf(":");
    if (separator === -1) {
      throw new Error(`Missing mapping separator at line ${index + 1}`);
    }

    const key = content.slice(0, separator).trim();
    const rawValue = content.slice(separator + 1).trim();
    if (!key) throw new Error(`Missing key at line ${index + 1}`);

    if (rawValue) {
      parent[key] = parseScalar(rawValue);
      return;
    }

    const nextLine = nextMeaningfulLine(lines, index + 1);
    const value: YamlContainer = nextLine?.startsWith("- ") ? [] : {};
    parent[key] = value;
    stack.push({ indent, value });
  });

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
      throw new Error(`Invalid YAML in ${fullPath}`);
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
