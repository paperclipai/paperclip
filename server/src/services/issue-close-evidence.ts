import { promises as fs } from "node:fs";
import path from "node:path";
import { issueCloseContractSchema, type IssueCloseContract } from "@paperclipai/shared";

const EXCLUDED_LOCAL_PATH_SEGMENTS = ["quarantine", "scratch", "cache"];

export type CloseEvidenceMeasurement = {
  closeContract: IssueCloseContract;
  measuredCount: number;
  targetCount: number;
  breakdown: {
    attachments: number;
    workProducts: number;
    localFiles: number;
  };
  localPath: string | null;
};

function normalizeRelativeEvidencePath(evidencePath: string) {
  return evidencePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(path.sep);
}

function resolveWorkProductsRoot(companyId: string) {
  const explicitRoot = process.env.PAPERCLIP_WORK_PRODUCTS_DIR?.trim();
  if (explicitRoot) return path.resolve(explicitRoot);

  const companyRoot = process.env.PAPERCLIP_COMPANY_ROOT?.trim();
  if (companyRoot) return path.resolve(companyRoot, "work-products");

  const homeDir = process.env.HOME?.trim();
  if (!homeDir) return null;
  return path.resolve(homeDir, ".paperclip/instances/default/companies", companyId, "work-products");
}

function isExcludedLocalSegment(segment: string) {
  const normalized = segment.trim().toLowerCase();
  return EXCLUDED_LOCAL_PATH_SEGMENTS.some((excluded) => normalized.includes(excluded));
}

async function countGovernedFiles(filePath: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(filePath, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (isExcludedLocalSegment(entry.name)) continue;
    const entryPath = path.join(filePath, entry.name);
    if (entry.isDirectory()) {
      count += await countGovernedFiles(entryPath);
      continue;
    }
    if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

export async function countCloseEvidenceLocalFiles(companyId: string, closeContract: IssueCloseContract) {
  const root = resolveWorkProductsRoot(companyId);
  if (!root) {
    return { count: 0, localPath: null };
  }

  const relativePath = normalizeRelativeEvidencePath(closeContract.evidencePath);
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(root, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return { count: 0, localPath: resolvedPath };
  }

  return {
    count: await countGovernedFiles(resolvedPath),
    localPath: resolvedPath,
  };
}

export async function measureCloseEvidence(input: {
  companyId: string;
  attachmentsCount: number;
  workProductsCount: number;
  closeContract: unknown;
}) {
  const parsed = issueCloseContractSchema.safeParse(input.closeContract);
  if (!parsed.success) return null;

  const { count: localFiles, localPath } = await countCloseEvidenceLocalFiles(input.companyId, parsed.data);
  const measuredCount = input.attachmentsCount + input.workProductsCount + localFiles;

  return {
    closeContract: parsed.data,
    measuredCount,
    targetCount: parsed.data.evidenceTarget,
    breakdown: {
      attachments: input.attachmentsCount,
      workProducts: input.workProductsCount,
      localFiles,
    },
    localPath,
  } satisfies CloseEvidenceMeasurement;
}
