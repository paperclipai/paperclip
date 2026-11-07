import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

export function cloudConfigurationDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

export const externalRegistrationEvidenceSchema = z.object({
  sourceLocatorDigest: z.string(),
  sourceDigest: z.string(),
  state: z.enum(["missing", "parsed", "invalid", "unreadable"]),
  adapterTypes: z.array(z.string()),
  blocker: z.enum(["unsupported_external_adapters", "invalid_external_registration_metadata", "unreadable_external_registration_metadata"]).nullable(),
}).strict();
export type ExternalRegistrationEvidence = z.infer<typeof externalRegistrationEvidenceSchema>;

const legacyRegistrationSchema = z.array(z.object({
  type: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  packageName: z.string().min(1).max(1024),
  version: z.string().max(128).optional(),
  localPath: z.string().max(4096).optional(),
  disabled: z.boolean().optional(),
}).passthrough()).max(100);

export async function inspectLegacyExternalRegistrations(filePath: string): Promise<ExternalRegistrationEvidence> {
  const sourceLocatorDigest = cloudConfigurationDigest(filePath);
  try {
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: unknown;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) throw new Error("invalid legacy registration file");
      const buffer = Buffer.alloc(65_537);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > 65_536) throw new Error("oversized legacy registration file");
      raw = JSON.parse(buffer.subarray(0, total).toString("utf8"));
    } finally {
      await file.close();
    }
    const records = legacyRegistrationSchema.safeParse(raw);
    if (!records.success) {
      return { sourceLocatorDigest, sourceDigest: cloudConfigurationDigest({ state: "invalid" }), state: "invalid", adapterTypes: [], blocker: "invalid_external_registration_metadata" };
    }
    const metadata = records.data.map((record) => ({ type: record.type, packageName: record.packageName, version: record.version, disabled: record.disabled, hasLocalPath: record.localPath !== undefined }));
    return {
      sourceLocatorDigest, sourceDigest: cloudConfigurationDigest(metadata), state: "parsed",
      adapterTypes: [...new Set(metadata.map((record) => record.type))].sort(),
      blocker: metadata.length ? "unsupported_external_adapters" : null,
    };
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
    const invalid = error instanceof SyntaxError || (error instanceof Error && /legacy registration file/.test(error.message));
    const state = absent ? "missing" : invalid ? "invalid" : "unreadable";
    return {
      sourceLocatorDigest, sourceDigest: cloudConfigurationDigest({ state }), state, adapterTypes: [],
      blocker: absent ? null : invalid ? "invalid_external_registration_metadata" : "unreadable_external_registration_metadata",
    };
  }
}
