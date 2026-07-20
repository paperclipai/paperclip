import { describe, expect, it } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { toResourcePayload, validateResourceDraft, type ResourceDraft } from "./Resources";

const validDraft: ResourceDraft = {
  key: "campaign",
  type: "git",
  repository: "https://github.com/acme/campaign.git",
  sourcePath: "content",
  defaultRef: "main",
  mountPath: "campaign",
  credentialRef: "11111111-1111-4111-8111-111111111111",
  labels: [{ key: "team", value: "marketing" }],
};

describe("Resource form contract", () => {
  it("provides a company-wide query prefix for active and archived list variants", () => {
    expect(queryKeys.resources.all("company-1")).toEqual(["resources", "company-1"]);
    expect(queryKeys.resources.list("company-1", false)).toEqual(["resources", "company-1", false]);
    expect(queryKeys.resources.list("company-1", true)).toEqual(["resources", "company-1", true]);
  });

  it("rejects unsafe mount and source paths", () => {
    expect(validateResourceDraft({ ...validDraft, mountPath: "../outside" })).toContain("Mount path");
    expect(validateResourceDraft({ ...validDraft, sourcePath: "../private" })).toContain("Source path");
  });

  it("rejects unsupported repository URLs", () => {
    expect(validateResourceDraft({ ...validDraft, repository: "ftp://github.com/acme/campaign.git" })).toContain("supported");
  });

  it("converts editable label rows to the API payload without secret values", () => {
    expect(toResourcePayload(validDraft)).toEqual({
      key: "campaign",
      type: "git",
      repository: "https://github.com/acme/campaign.git",
      sourcePath: "content",
      defaultRef: "main",
      mountPath: "campaign",
      credentialRef: "11111111-1111-4111-8111-111111111111",
      labels: { team: "marketing" },
    });
  });
});
