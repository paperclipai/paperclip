import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { approvedFreshness } from "../services/routine-checks/checks/approved-freshness.js";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
const fsStub = {} as unknown as typeof import("node:fs/promises");

describe("approved-freshness", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "freshness-"));
    process.env.PAPERCLIP_CREATIVE_ROOT = tmp;
  });
  afterEach(async () => {
    delete process.env.PAPERCLIP_CREATIVE_ROOT;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeApproval(project: string, kampagne: string, item: string, signoffDate: string | null): Promise<void> {
    const dir = path.join(tmp, project, "assets", kampagne, "04-approved", item);
    await fs.mkdir(dir, { recursive: true });
    const body = signoffDate
      ? `Header\n\n✅ sign-off marco ${signoffDate} 12:00\n`
      : "Header\n\nNo sign-off line\n";
    await fs.writeFile(path.join(dir, "APPROVAL.md"), body);
  }

  it("returns ok when no projects exist", async () => {
    const r = await approvedFreshness.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.status).toBe("ok");
    expect(r.findings).toBe(0);
  });

  it("flags items signed >14 days ago", async () => {
    await writeApproval("projA", "k1", "item1", "2026-04-10");
    const r = await approvedFreshness.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date("2026-04-30T00:00:00Z") });
    expect(r.findings).toBe(1);
    expect((r.payload as any).stale_items[0].age_days).toBe(20);
    expect(r.status).toBe("warn");
  });

  it("does NOT flag items signed within last 14 days", async () => {
    await writeApproval("projA", "k1", "item1", "2026-04-25");
    const r = await approvedFreshness.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date("2026-04-30T00:00:00Z") });
    expect(r.findings).toBe(0);
    expect(r.status).toBe("ok");
  });

  it("flags items with missing APPROVAL.md", async () => {
    const dir = path.join(tmp, "projA/assets/k1/04-approved/item1");
    await fs.mkdir(dir, { recursive: true });
    const r = await approvedFreshness.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.findings).toBe(1);
    expect((r.payload as any).stale_items[0].age_days).toBe(-1);
  });

  it("flags items with APPROVAL.md but no sign-off line", async () => {
    await writeApproval("projA", "k1", "item1", null);
    const r = await approvedFreshness.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.findings).toBe(1);
    expect((r.payload as any).stale_items[0].age_days).toBe(-1);
  });

  it("aggregates across multiple projects and kampagnen", async () => {
    await writeApproval("projA", "k1", "item1", "2026-04-10");
    await writeApproval("projA", "k2", "item2", "2026-04-25");
    await writeApproval("projB", "k1", "item3", "2026-04-01");
    const r = await approvedFreshness.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date("2026-04-30T00:00:00Z") });
    expect(r.findings).toBe(2);
    const stale = (r.payload as any).stale_items as Array<{ project: string; item: string }>;
    expect(stale.find((s) => s.item === "item1")).toBeDefined();
    expect(stale.find((s) => s.item === "item3")).toBeDefined();
    expect(stale.find((s) => s.item === "item2")).toBeUndefined();
  });
});
