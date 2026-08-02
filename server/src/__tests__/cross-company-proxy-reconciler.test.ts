import { describe, expect, it } from "vitest";
import { findDuplicateParentProxies, parseCrossCompanyProxy } from "../services/cross-company-proxy-reconciler.js";

describe("parseCrossCompanyProxy", () => {
  it("parses the single-foreign-issue child pattern from TSMC-18763", () => {
    const description = [
      "Source: [TSMC-18560](/TSMC/issues/TSMC-18560).",
      "",
      "This local follow-up tracks unresolved cross-company smoke issue [TSM-5956](/TSM/issues/TSM-5956) after the 2026-07-31 relane.",
      "Paperclip rejected direct cross-company blockers on TSMC-18560 with the validation message \"Blocked-by issues must belong to the same company\", so this TSMC child issue exists to represent that foreign blocker locally.",
    ].join("\n");

    expect(parseCrossCompanyProxy(description, "TSMC")).toEqual({
      remoteIdentifier: "TSM-5956",
      remotePrefix: "TSM",
    });
  });

  it("rejects descriptions that do not name the proxy pattern", () => {
    const description = "This issue mentions [TSM-5956](/TSM/issues/TSM-5956) but is not a local blocker proxy.";
    expect(parseCrossCompanyProxy(description, "TSMC")).toBeNull();
  });

  it("rejects descriptions that name more than one foreign issue", () => {
    const description = [
      "Cross-company follow-up.",
      "Paperclip rejected direct cross-company blockers with \"Blocked-by issues must belong to the same company\".",
      "[TSM-5956](/TSM/issues/TSM-5956)",
      "[TSK-6485](/TSK/issues/TSK-6485)",
    ].join("\n");
    expect(parseCrossCompanyProxy(description, "TSMC")).toBeNull();
  });
});

describe("findDuplicateParentProxies", () => {
  it("flags more than one open proxy under the same parent", () => {
    const findings = findDuplicateParentProxies([
      {
        id: "child-a",
        identifier: "TSMC-18763",
        title: "Post-relane smoke blocker: TSM-5956",
        description: null,
        status: "blocked",
        companyId: "tsmc",
        companyPrefix: "TSMC",
        parentId: "parent-1",
        parsed: { remoteIdentifier: "TSM-5956", remotePrefix: "TSM" },
      },
      {
        id: "child-b",
        identifier: "TSMC-18764",
        title: "Post-relane smoke blocker: TSK-6485",
        description: null,
        status: "blocked",
        companyId: "tsmc",
        companyPrefix: "TSMC",
        parentId: "parent-1",
        parsed: { remoteIdentifier: "TSK-6485", remotePrefix: "TSK" },
      },
    ], new Map([["parent-1", "TSMC-18560"]]));

    expect(findings).toEqual([
      {
        parentId: "parent-1",
        parentIdentifier: "TSMC-18560",
        childIdentifiers: ["TSMC-18763", "TSMC-18764"],
        remoteIdentifiers: ["TSK-6485", "TSM-5956"],
      },
    ]);
  });
});
