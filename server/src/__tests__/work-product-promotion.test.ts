import { promises as fs, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildIssueKeyCompanyResolver,
  promoteRunWorkProducts,
} from "../services/work-product-promotion.js";

// TSMC-21543. Agents write work-products into project SCRATCH and the promotion
// step to companies/<id>/work-products was routinely skipped, leaving artifacts
// on a deletion path (proved concrete by the 2026-08-25 ws-gc sweep).
//
// The two rejected designs are what these tests pin:
//  * a symlink to ONE company's store — disproved: 57 of 177 measured trees
//    belonged to a different company than their workspace, so routing is by
//    ISSUE PREFIX, not by workspace;
//  * a recurring sweep — disproved: 177 -> 1 -> 6 -> 3 in fifteen minutes,
//    so this runs per-run at finalization instead.

const COMPANY_TSMC = "11111111-1111-1111-1111-111111111111";
const COMPANY_DP = "22222222-2222-2222-2222-222222222222";

const resolver = buildIssueKeyCompanyResolver([
  { id: COMPANY_TSMC, issuePrefix: "TSMC" },
  { id: COMPANY_DP, issuePrefix: "DP" },
]);

let home: string;
let workspace: string;
let prevHome: string | undefined;
let prevExplicit: string | undefined;

const durableFor = (companyId: string, issueKey: string) =>
  path.join(home, "instances", "default", "companies", companyId, "work-products", issueKey);

async function seedScratch(issueKey: string, file: string, body: string) {
  const dir = path.join(workspace, "work-products", issueKey);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), body);
  return dir;
}

beforeEach(async () => {
  prevHome = process.env.PAPERCLIP_HOME;
  prevExplicit = process.env.PAPERCLIP_WORK_PRODUCTS_DIR;
  delete process.env.PAPERCLIP_WORK_PRODUCTS_DIR;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "wp-home-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wp-ws-"));
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = "default";
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = prevHome;
  if (prevExplicit !== undefined) process.env.PAPERCLIP_WORK_PRODUCTS_DIR = prevExplicit;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("work-products are promoted at run finalization (TSMC-21543)", () => {
  it("promotes a tree the run wrote into the owning company's durable store", async () => {
    await seedScratch("TSMC-21596", "audit.md", "findings");
    const res = await promoteRunWorkProducts({
      workspaceCwd: workspace,
      sinceMs: Date.now() - 60_000,
      resolveCompanyIdForIssueKey: resolver,
    });
    expect(res.promoted.map((p) => p.issueKey)).toContain("TSMC-21596");
    await expect(fs.readFile(path.join(durableFor(COMPANY_TSMC, "TSMC-21596"), "audit.md"), "utf8"))
      .resolves.toBe("findings");
  });

  it("routes a CROSS-COMPANY tree by issue prefix, not by the workspace it sat in", async () => {
    // The exact case that killed the symlink design: a DP tree in a TSMC workspace.
    await seedScratch("DP-4764", "listing.md", "dp work");
    const res = await promoteRunWorkProducts({
      workspaceCwd: workspace,
      sinceMs: Date.now() - 60_000,
      resolveCompanyIdForIssueKey: resolver,
    });
    expect(res.promoted).toEqual([{ issueKey: "DP-4764", companyId: COMPANY_DP }]);
    await expect(fs.readFile(path.join(durableFor(COMPANY_DP, "DP-4764"), "listing.md"), "utf8"))
      .resolves.toBe("dp work");
    // and must NOT have been filed under the workspace's own company
    await expect(fs.access(durableFor(COMPANY_TSMC, "DP-4764"))).rejects.toThrow();
  });

  it("is additive: an existing durable file is never overwritten by scratch", async () => {
    await seedScratch("TSMC-21596", "audit.md", "STALE scratch copy");
    const dest = durableFor(COMPANY_TSMC, "TSMC-21596");
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, "audit.md"), "PROMOTED original");
    await promoteRunWorkProducts({
      workspaceCwd: workspace,
      sinceMs: Date.now() - 60_000,
      resolveCompanyIdForIssueKey: resolver,
    });
    await expect(fs.readFile(path.join(dest, "audit.md"), "utf8")).resolves.toBe("PROMOTED original");
  });

  it("ignores a tree untouched by this run", async () => {
    const dir = await seedScratch("TSMC-20000", "old.md", "ancient");
    const old = new Date(Date.now() - 86_400_000);
    await fs.utimes(dir, old, old);
    const res = await promoteRunWorkProducts({
      workspaceCwd: workspace,
      sinceMs: Date.now() - 60_000,
      resolveCompanyIdForIssueKey: resolver,
    });
    expect(res.considered).toBe(0);
    expect(res.promoted).toEqual([]);
  });

  it("records an unknown prefix rather than guessing a company", async () => {
    await seedScratch("ZZZ-1", "x.md", "orphan");
    const res = await promoteRunWorkProducts({
      workspaceCwd: workspace,
      sinceMs: Date.now() - 60_000,
      resolveCompanyIdForIssueKey: resolver,
    });
    expect(res.skippedUnknownCompany).toEqual(["ZZZ-1"]);
    expect(res.promoted).toEqual([]);
  });

  it("no-ops when the scratch root is already a symlink to a durable location", async () => {
    // TSBC does exactly this; copying through it would duplicate, not promote.
    const elsewhere = path.join(home, "already-durable");
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.symlink(elsewhere, path.join(workspace, "work-products"));
    const res = await promoteRunWorkProducts({
      workspaceCwd: workspace,
      sinceMs: Date.now() - 60_000,
      resolveCompanyIdForIssueKey: resolver,
    });
    expect(res).toMatchObject({ considered: 0, promoted: [] });
  });

  it("never throws when the run wrote no work-products at all", async () => {
    await expect(promoteRunWorkProducts({
      workspaceCwd: path.join(workspace, "does-not-exist"),
      sinceMs: Date.now(),
      resolveCompanyIdForIssueKey: resolver,
    })).resolves.toMatchObject({ promoted: [] });
  });
});


describe("run finalization is wired to the promoter (TSMC-21543)", () => {
  // A wiring assertion, labelled as such: the tests above prove the promoter
  // behaves, but cannot prove finalization CALLS it. TSKB0055 K45 is the reason
  // this is stated plainly rather than dressed up as behaviour.
  const heartbeatSrc = readFileSync(
    fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
    "utf8",
  );

  it("promotes immediately after the workspace_finalize barrier is recorded", () => {
    const idx = heartbeatSrc.indexOf('await recordWorkspaceFinalize("succeeded");');
    expect(idx).toBeGreaterThan(-1);
    const afterFinalize = heartbeatSrc.slice(idx, idx + 2000);
    expect(afterFinalize).toContain("promoteRunWorkProducts(");
    expect(afterFinalize).toContain("buildIssueKeyCompanyResolver(");
  });

  it("cannot fail the run: the promotion is wrapped and only warns", () => {
    const idx = heartbeatSrc.indexOf("promoteRunWorkProducts(");
    const around = heartbeatSrc.slice(Math.max(0, idx - 900), idx + 1600);
    expect(around).toContain("try {");
    expect(around).toContain("work-product promotion failed");
  });
});
