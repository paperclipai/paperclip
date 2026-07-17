import { describe, expect, it } from "vitest";
import { toResourcePayload, validateResourceDraft, type ResourceDraft } from "./Resources";

const validDraft: ResourceDraft = {
  key: "campaign",
  type: "git",
  repository: "https://github.com/acme/campaign.git",
  sourcePath: "content",
  defaultRef: "main",
  mountPath: "campaign",
  credentialRef: "secret-1",
  labels: [{ key: "team", value: "marketing" }],
};

describe("Resource form contract", () => {
  it("rejects unsafe mount and source paths", () => {
    expect(validateResourceDraft({ ...validDraft, mountPath: "../outside" })).toContain("Mount path");
    expect(validateResourceDraft({ ...validDraft, sourcePath: "../private" })).toContain("Source path");
  });

  it("converts editable label rows to the API payload without secret values", () => {
    expect(toResourcePayload(validDraft)).toEqual({
      key: "campaign",
      type: "git",
      repository: "https://github.com/acme/campaign.git",
      sourcePath: "content",
      defaultRef: "main",
      mountPath: "campaign",
      credentialRef: "secret-1",
      labels: { team: "marketing" },
    });
  });
});
