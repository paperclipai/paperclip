import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePaperclipCompanyWorkProductsDir } from "@paperclipai/shared/home-paths";

// TSMC-21543 / TSMC-21549. Agents write work-products into the project
// workspace's scratch `work-products/<ISSUE>/`; promotion to the durable store
// (`companies/<id>/work-products`) was a SEPARATE step they routinely skipped.
// Anything unpromoted sat on a deletion path — the 2026-08-25 ws-gc sweep is
// what made that concrete.
//
// Two designs were rejected before this one, both on evidence:
//
//  * Symlink the scratch dir at the company's durable store. Measured on
//    2026-08-25: of 177 un-promoted trees, **57 belonged to a DIFFERENT company
//    than the workspace holding them** (TSMC workspaces holding DP-, TSM-, TSR-
//    and TSBC- trees, because TSMC agents do platform work across the
//    portfolio). A symlink points at one company and would have misfiled them.
//
//  * A recurring sweep. Measured the same day: 177 -> promote -> 1 -> promote
//    -> 6 -> promote -> 3. Scratch regenerates while you sweep it, so a sweep
//    bounds the loss window and never closes it.
//
// So this runs at RUN FINALIZATION, keyed on the ISSUE prefix rather than the
// workspace's company: event-driven, so it converges, and it routes
// cross-company trees correctly.

export type WorkProductPromotionResult = {
  considered: number;
  promoted: Array<{ issueKey: string; companyId: string }>;
  skippedUnknownCompany: string[];
  failed: Array<{ issueKey: string; reason: string }>;
};

const EMPTY: WorkProductPromotionResult = {
  considered: 0,
  promoted: [],
  skippedUnknownCompany: [],
  failed: [],
};

function resolveDurableRoot(companyId: string): string | null {
  const explicitRoot = process.env.PAPERCLIP_WORK_PRODUCTS_DIR?.trim();
  if (explicitRoot) return path.resolve(explicitRoot);
  try {
    return resolvePaperclipCompanyWorkProductsDir(companyId, {
      homeDir: process.env.PAPERCLIP_HOME?.trim(),
      instanceId: process.env.PAPERCLIP_INSTANCE_ID?.trim(),
    });
  } catch {
    return null;
  }
}

/**
 * Promote work-product trees a run wrote in its workspace scratch into the
 * durable store of the company that OWNS each issue.
 *
 * Never throws: a promotion failure must not fail an otherwise-successful run.
 * Additive only (`force: false`) — an existing durable file always wins, so a
 * stale scratch copy can never clobber the promoted one.
 */
export async function promoteRunWorkProducts(input: {
  workspaceCwd: string | null | undefined;
  /** Only trees modified at or after this instant are considered. */
  sinceMs: number;
  /** e.g. "TSM-6048" -> owning companyId, or null when the prefix is unknown. */
  resolveCompanyIdForIssueKey: (issueKey: string) => string | null;
}): Promise<WorkProductPromotionResult> {
  const cwd = input.workspaceCwd?.trim();
  if (!cwd) return EMPTY;

  const scratchRoot = path.join(cwd, "work-products");
  let rootStat;
  try {
    rootStat = await fs.lstat(scratchRoot);
  } catch {
    return EMPTY; // the run wrote no work-products
  }
  // A symlinked scratch root already writes straight into a durable location
  // (TSBC does this). Copying through it would duplicate, not promote.
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return EMPTY;

  const result: WorkProductPromotionResult = {
    considered: 0,
    promoted: [],
    skippedUnknownCompany: [],
    failed: [],
  };

  let entries;
  try {
    entries = await fs.readdir(scratchRoot, { withFileTypes: true });
  } catch (err) {
    result.failed.push({ issueKey: "(readdir)", reason: err instanceof Error ? err.message : String(err) });
    return result;
  }

  for (const entry of entries) {
    // `isDirectory()` is false for a symlinked tree, which is what we want:
    // never follow one out of the workspace.
    if (!entry.isDirectory()) continue;
    const issueKey = entry.name;
    const src = path.join(scratchRoot, issueKey);

    try {
      const stat = await fs.stat(src);
      if (stat.mtimeMs < input.sinceMs) continue; // untouched by this run
    } catch {
      continue;
    }
    result.considered += 1;

    const companyId = input.resolveCompanyIdForIssueKey(issueKey);
    if (!companyId) {
      result.skippedUnknownCompany.push(issueKey);
      continue;
    }
    const durableRoot = resolveDurableRoot(companyId);
    if (!durableRoot) {
      result.skippedUnknownCompany.push(issueKey);
      continue;
    }

    const dest = path.join(durableRoot, issueKey);
    try {
      await fs.mkdir(dest, { recursive: true });
      await fs.cp(src, dest, {
        recursive: true,
        force: false,        // additive: never overwrite a durable file
        errorOnExist: false,
        dereference: false,  // do not follow symlinks out of the workspace
      });
      result.promoted.push({ issueKey, companyId });
    } catch (err) {
      result.failed.push({ issueKey, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

/** Build a prefix -> companyId resolver from company rows. */
export function buildIssueKeyCompanyResolver(
  companies: Array<{ id: string; issuePrefix?: string | null }>,
): (issueKey: string) => string | null {
  const byPrefix = new Map<string, string>();
  for (const c of companies) {
    const p = c.issuePrefix?.trim();
    if (p) byPrefix.set(p.toUpperCase(), c.id);
  }
  return (issueKey: string) => {
    const prefix = issueKey.split("-")[0]?.trim().toUpperCase();
    if (!prefix) return null;
    return byPrefix.get(prefix) ?? null;
  };
}
