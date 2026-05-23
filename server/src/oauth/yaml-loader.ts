import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  OAuthProviderConfigSchema,
  type OAuthProviderConfig,
} from "./provider-config.js";
import { logger } from "../middleware/logger.js";

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
      parsed = parseYaml(raw);
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
