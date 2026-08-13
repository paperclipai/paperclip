import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("application provider order", () => {
  it("mounts OrgProvider outside CompanyProvider", () => {
    const source = readFileSync(fileURLToPath(new URL("./main.tsx", import.meta.url)), "utf8");
    const orgOpen = source.indexOf("<OrgProvider>");
    const companyOpen = source.indexOf("<CompanyProvider>");
    const companyClose = source.indexOf("</CompanyProvider>");
    const orgClose = source.indexOf("</OrgProvider>");

    expect(orgOpen).toBeGreaterThan(-1);
    expect(companyOpen).toBeGreaterThan(orgOpen);
    expect(companyClose).toBeGreaterThan(companyOpen);
    expect(orgClose).toBeGreaterThan(companyClose);
  });
});
