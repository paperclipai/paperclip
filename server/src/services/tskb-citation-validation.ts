import { promises as fs } from "node:fs";
import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

const TSKB_CITATION_REGEX = /\bTSKB(\d{4})\b/g;
const TSKB_REGISTRY_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export interface TskbCitationSource {
  label: string;
  text?: string | null;
}

export interface TskbCitationFinding {
  label: string;
  citedIds: string[];
  unresolvedIds: string[];
}

interface TskbRegistryFile {
  version?: unknown;
  generatedAt?: unknown;
  canonicalIds?: unknown;
  burnedIds?: unknown;
  resolvableIds?: unknown;
}

export interface TskbCitationValidationResult {
  registryPath: string;
  registryGeneratedAt: string | null;
  findings: TskbCitationFinding[];
}

function collectCitationIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(TSKB_CITATION_REGEX)) {
    const id = match[1];
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

function normalizeIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(
    input
      .filter((value): value is string => typeof value === "string" && /^\d{4}$/.test(value))
      .map((value) => value.trim()),
  )].sort();
}

async function loadRegistry() {
  const registryPath = process.env.TSKB_REGISTRY_PATH?.trim();
  if (!registryPath) return null;

  let stat;
  try {
    stat = await fs.stat(registryPath);
  } catch (err) {
    logger.warn({ err, registryPath }, "skipping TSKB citation validation because registry is unavailable");
    return null;
  }

  let parsed: TskbRegistryFile;
  try {
    parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as TskbRegistryFile;
  } catch (err) {
    logger.warn({ err, registryPath }, "skipping TSKB citation validation because registry could not be parsed");
    return null;
  }

  const generatedAt =
    typeof parsed.generatedAt === "string" && Number.isFinite(Date.parse(parsed.generatedAt))
      ? new Date(parsed.generatedAt)
      : null;
  const newestRegistryProofMs = Math.max(
    stat.mtimeMs,
    generatedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(newestRegistryProofMs) || (Date.now() - newestRegistryProofMs) > TSKB_REGISTRY_MAX_AGE_MS) {
    logger.warn(
      {
        registryPath,
        generatedAt: generatedAt?.toISOString() ?? null,
        mtime: new Date(stat.mtimeMs).toISOString(),
      },
      "skipping TSKB citation validation because registry is stale",
    );
    return null;
  }

  const canonicalIds = normalizeIdList(parsed.canonicalIds);
  const burnedIds = normalizeIdList(parsed.burnedIds);
  const resolvableIds = normalizeIdList(parsed.resolvableIds);
  const validIds = new Set<string>([...canonicalIds, ...burnedIds, ...resolvableIds]);
  return {
    registryPath,
    generatedAt: generatedAt?.toISOString() ?? null,
    validIds,
  };
}

export async function validateTskbCitations(
  sources: readonly TskbCitationSource[],
): Promise<TskbCitationValidationResult | null> {
  const registry = await loadRegistry();
  if (!registry) return null;

  const findings: TskbCitationFinding[] = [];
  for (const source of sources) {
    if (!source.text) continue;
    const citedIds = collectCitationIds(source.text);
    if (citedIds.length === 0) continue;
    const unresolvedIds = citedIds.filter((id) => !registry.validIds.has(id));
    if (unresolvedIds.length === 0) continue;
    findings.push({
      label: source.label,
      citedIds,
      unresolvedIds,
    });
  }

  if (findings.length === 0) return null;
  return {
    registryPath: registry.registryPath,
    registryGeneratedAt: registry.generatedAt,
    findings,
  };
}

export function buildTskbCitationWarningComment(input: TskbCitationValidationResult): {
  body: string;
  metadata: IssueCommentMetadata;
  presentation: IssueCommentPresentation;
} {
  const findingLines = input.findings.map((finding) => {
    const refs = finding.unresolvedIds.map((id) => `TSKB${id}`).join(", ");
    return `${finding.label}: ${refs}`;
  });
  const body = [
    "Write-time TSKB citation warning.",
    ...findingLines,
    `Registry: ${input.registryPath}`,
  ].join("\n");

  const metadata: IssueCommentMetadata = {
    version: 1,
    sections: [
      {
        title: "Unresolved citations",
        rows: input.findings.map((finding) => ({
          type: "key_value" as const,
          label: finding.label,
          value: finding.unresolvedIds.map((id) => `TSKB${id}`).join(", "),
        })),
      },
      {
        title: "Registry",
        rows: [
          { type: "key_value" as const, label: "Path", value: input.registryPath },
          {
            type: "key_value" as const,
            label: "Generated",
            value: input.registryGeneratedAt ?? "unknown",
          },
          { type: "key_value" as const, label: "Flag", value: "TSKB_REGISTRY_PATH" },
        ],
      },
    ],
  };

  return {
    body,
    metadata,
    presentation: {
      kind: "system_notice",
      tone: "warning",
      title: "Unresolved TSKB citation",
      detailsDefaultOpen: false,
    },
  };
}
