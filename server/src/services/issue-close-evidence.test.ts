import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countCloseEvidenceLocalFiles } from "./issue-close-evidence.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("countCloseEvidenceLocalFiles", () => {
  it("counts files from a configured relocated work-products root", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-close-evidence-"));
    const relocatedRoot = path.join(home, "external-work-products", "company-1");
    const issueRoot = path.join(relocatedRoot, "TSMC-18953");
    delete process.env.PAPERCLIP_WORK_PRODUCTS_DIR;
    delete process.env.PAPERCLIP_COMPANY_ROOT;
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "instance-a";

    const companyConfigDir = path.join(home, "instances", "instance-a", "companies", "company-1");
    fs.mkdirSync(companyConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(companyConfigDir, "config.json"),
      `${JSON.stringify({ workProductsRoot: relocatedRoot }, null, 2)}\n`,
      "utf8",
    );
    fs.mkdirSync(path.join(issueRoot, "nested"), { recursive: true });
    fs.writeFileSync(path.join(issueRoot, "a.txt"), "a\n", "utf8");
    fs.writeFileSync(path.join(issueRoot, "nested", "b.txt"), "b\n", "utf8");

    await expect(
      countCloseEvidenceLocalFiles("company-1", {
        mode: "evidence",
        evidenceTarget: 2,
        evidencePath: "TSMC-18953",
        artifactKind: "generated_media",
      }),
    ).resolves.toEqual({
      count: 2,
      localPath: issueRoot,
    });
  });
});
