import fs from "node:fs";
import { adapterRegistrySchema, type AdapterRegistryEntryParsed } from "@paperclipai/shared";

export type AdapterRegistryEnv = Record<string, string | undefined>;

let cached: { inline: string | undefined; filePath: string | undefined; registry: AdapterRegistryEntryParsed[] } | undefined;

export function parseAdapterRegistryEnv(
  env: AdapterRegistryEnv = process.env,
): AdapterRegistryEntryParsed[] | null {
  const inline = env.PAPERCLIP_ADAPTERS?.trim();
  const filePath = env.PAPERCLIP_ADAPTERS_FILE?.trim();
  if (!inline && !filePath) return null;
  if (cached && cached.inline === inline && cached.filePath === filePath) return structuredClone(cached.registry);

  let rawText: string;
  if (inline) {
    rawText = inline;
  } else {
    try {
      rawText = fs.readFileSync(filePath as string, "utf-8");
    } catch (err) {
      throw new Error(
        `PAPERCLIP_ADAPTERS_FILE could not be read at "${filePath}": ${(err as Error).message}`,
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`PAPERCLIP_ADAPTERS must be valid JSON: ${(err as Error).message}`);
  }

  const result = adapterRegistrySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `PAPERCLIP_ADAPTERS failed validation: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  cached = { inline, filePath, registry: result.data };
  return structuredClone(result.data);
}

