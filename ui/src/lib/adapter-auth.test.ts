import { describe, expect, it } from "vitest";
import type { AdapterAuthStatusResponse } from "@paperclipai/shared";
import {
  applyAdapterAuthSelections,
  countUnresolvedAdapterAuth,
  pruneAdapterAuthSelections,
} from "./adapter-auth";

const baseStatus: AdapterAuthStatusResponse = {
  adapterType: "codex_local",
  unresolvedCount: 1,
  status: "unresolved",
  requirements: [
    {
      requirementId: "codex_local:openai",
      source: "fixed_adapter",
      provider: "openai",
      requiredEnvKeys: ["OPENAI_API_KEY"],
      resolved: false,
      resolvedBy: "unresolved",
      resolvedEnvKey: null,
      resolvedCredentialId: null,
      defaultCredentialId: null,
      unresolvedReason: "Codex requires OPENAI_API_KEY.",
      availableCredentials: [
        {
          id: "cred-openai",
          companyId: "company-1",
          provider: "openai",
          envKey: "OPENAI_API_KEY",
          label: "Primary",
          secretId: "secret-openai",
          isDefault: false,
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          secretName: "OPENAI_API_KEY__PRIMARY",
          secretLatestVersion: 1,
          secretUpdatedAt: new Date("2026-04-01T00:00:00.000Z"),
        },
      ],
    },
  ],
};

describe("adapter auth helpers", () => {
  it("treats selected available credentials as resolved", () => {
    const unresolved = countUnresolvedAdapterAuth(baseStatus, {});
    const resolved = countUnresolvedAdapterAuth(baseStatus, {
      "codex_local:openai": "cred-openai",
    });

    expect(unresolved).toBe(1);
    expect(resolved).toBe(0);
  });

  it("injects selected credential secret refs into adapterConfig.env", () => {
    const config = applyAdapterAuthSelections(
      {},
      baseStatus,
      { "codex_local:openai": "cred-openai" },
    );

    expect(config).toMatchObject({
      env: {
        OPENAI_API_KEY: {
          type: "secret_ref",
          secretId: "secret-openai",
          version: "latest",
        },
      },
    });
  });

  it("prunes selections that are no longer available", () => {
    const pruned = pruneAdapterAuthSelections(baseStatus, {
      "codex_local:openai": "missing-credential",
    });
    expect(pruned).toEqual({});
  });
});
