import { describe, expect, it } from "vitest";
import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import {
  computeDuplicateNames,
  computeRowHealth,
  computeUserSecretRowHealth,
  emptyRow,
  envKeyFromSecretName,
  planSourceSwitch,
  rowsFromValue,
  secretNameFromKey,
  validateName,
  valueFromRows,
  type EnvRow,
} from "./model";

function makeUserSecretDefinition(overrides: { key: string; status?: "active" | "disabled" | "archived" }): UserSecretDefinition {
  return {
    id: `def-${overrides.key}`,
    companyId: "co",
    key: overrides.key,
    name: overrides.key.toUpperCase(),
    description: null,
    status: overrides.status ?? "active",
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    providerConfigId: null,
    providerMetadata: null,
    usageGuidance: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    deletedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function makeSecret(overrides: Partial<CompanySecret> & Pick<CompanySecret, "id">): CompanySecret {
  return {
    companyId: "co",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: overrides.id,
    name: overrides.id.toUpperCase(),
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("rowsFromValue", () => {
  it("returns no rows for empty/undefined input (no ghost row)", () => {
    expect(rowsFromValue(undefined)).toEqual([]);
    expect(rowsFromValue({})).toEqual([]);
  });

  it("maps legacy string, plain, secret_ref, and user_secret_ref bindings", () => {
    const rows = rowsFromValue({
      LEGACY: "raw",
      PLAIN: { type: "plain", value: "v" },
      REF: { type: "secret_ref", secretId: "s1", version: 2 },
      REF_LATEST: { type: "secret_ref", secretId: "s2" },
      USER_REF: { type: "user_secret_ref", key: "github_token", version: "latest", required: false },
    });
    expect(
      rows.map((r) => ({
        name: r.name,
        source: r.source,
        textValue: r.textValue,
        secretId: r.secretId,
        userSecretKey: r.userSecretKey,
        required: r.required,
        version: r.version,
      })),
    ).toEqual([
      { name: "LEGACY", source: "text", textValue: "raw", secretId: "", userSecretKey: "", required: true, version: "latest" },
      { name: "PLAIN", source: "text", textValue: "v", secretId: "", userSecretKey: "", required: true, version: "latest" },
      { name: "REF", source: "secret", textValue: "", secretId: "s1", userSecretKey: "", required: true, version: 2 },
      { name: "REF_LATEST", source: "secret", textValue: "", secretId: "s2", userSecretKey: "", required: true, version: "latest" },
      {
        name: "USER_REF",
        source: "user_secret",
        textValue: "",
        secretId: "",
        userSecretKey: "github_token",
        required: false,
        version: "latest",
      },
    ]);
  });
});

describe("valueFromRows (emit semantics)", () => {
  function row(partial: Partial<EnvRow>): EnvRow {
    return { ...emptyRow(), ...partial };
  }

  it("emits undefined when there are no complete rows", () => {
    expect(valueFromRows([])).toBeUndefined();
    expect(valueFromRows([row({ name: "" })])).toBeUndefined();
  });

  it("drops rows with empty (trimmed) names", () => {
    expect(valueFromRows([row({ name: "   ", textValue: "x" })])).toBeUndefined();
  });

  it("drops secret rows without a chosen secret (incomplete ref)", () => {
    expect(valueFromRows([row({ name: "A", source: "secret", secretId: "" })])).toBeUndefined();
  });

  it("drops user-secret rows without a chosen definition key", () => {
    expect(valueFromRows([row({ name: "A", source: "user_secret", userSecretKey: "" })])).toBeUndefined();
  });

  it("emits plain, secret_ref, and user_secret_ref bindings", () => {
    expect(
      valueFromRows([
        row({ name: "A", source: "text", textValue: "1" }),
        row({ name: "B", source: "secret", secretId: "s1", version: 2 }),
        row({ name: "C", source: "user_secret", userSecretKey: "github_token", required: false }),
      ]),
    ).toEqual({
      A: { type: "plain", value: "1" },
      B: { type: "secret_ref", secretId: "s1", version: 2 },
      C: { type: "user_secret_ref", key: "github_token", version: "latest", required: false },
    });
  });

  it("is last-writer-wins on duplicate names", () => {
    expect(
      valueFromRows([
        row({ name: "A", textValue: "first" }),
        row({ name: "A", textValue: "second" }),
      ]),
    ).toEqual({ A: { type: "plain", value: "second" } });
  });
});

describe("validateName", () => {
  const reserved = ["PAPERCLIP_"];

  it("returns null for empty and valid names", () => {
    expect(validateName("", new Set(), reserved)).toBeNull();
    expect(validateName("GH_TOKEN", new Set(), reserved)).toBeNull();
    expect(validateName("_private1", new Set(), reserved)).toBeNull();
  });

  it("flags invalid charset", () => {
    expect(validateName("1BAD", new Set(), reserved)?.level).toBe("error");
    expect(validateName("has-dash", new Set(), reserved)?.message).toMatch(/letters, digits/);
  });

  it("flags duplicates as errors", () => {
    expect(validateName("DUP", new Set(["DUP"]), reserved)).toEqual({ level: "error", message: "Duplicate name" });
  });

  it("flags reserved prefixes as warnings", () => {
    const issue = validateName("PAPERCLIP_HOME", new Set(), reserved);
    expect(issue?.level).toBe("warn");
    expect(issue?.message).toMatch(/Reserved prefix/);
  });

  it("charset error takes precedence over reserved prefix", () => {
    expect(validateName("PAPERCLIP-X", new Set(), reserved)?.level).toBe("error");
  });
});

describe("computeDuplicateNames", () => {
  it("collects names appearing more than once", () => {
    const rows = [
      { ...emptyRow(), name: "A" },
      { ...emptyRow(), name: "A" },
      { ...emptyRow(), name: "B" },
      { ...emptyRow(), name: "" },
    ];
    expect([...computeDuplicateNames(rows)]).toEqual(["A"]);
  });
});

describe("computeRowHealth", () => {
  const secrets = [makeSecret({ id: "active" }), makeSecret({ id: "disabled", status: "disabled" })];

  it("returns null for healthy secret and text rows", () => {
    expect(computeRowHealth({ ...emptyRow(), source: "text", name: "A", textValue: "x" }, secrets)).toBeNull();
    expect(computeRowHealth({ ...emptyRow(), source: "secret", secretId: "active" }, secrets)).toBeNull();
  });

  it("flags a missing secret as an error", () => {
    expect(computeRowHealth({ ...emptyRow(), source: "secret", secretId: "gone" }, secrets)?.kind).toBe("missing");
  });

  it("flags a disabled secret as a warning", () => {
    expect(computeRowHealth({ ...emptyRow(), source: "secret", secretId: "disabled" }, secrets)?.kind).toBe("disabled");
  });
});

describe("computeUserSecretRowHealth", () => {
  const definitions = [
    makeUserSecretDefinition({ key: "active" }),
    makeUserSecretDefinition({ key: "disabled", status: "disabled" }),
  ];

  it("returns null for healthy user-secret refs and non-user-secret rows", () => {
    expect(computeUserSecretRowHealth({ ...emptyRow(), source: "text", name: "A" }, definitions)).toBeNull();
    expect(
      computeUserSecretRowHealth({ ...emptyRow(), source: "user_secret", userSecretKey: "active" }, definitions),
    ).toBeNull();
  });

  it("flags missing and disabled user-secret definitions", () => {
    expect(computeUserSecretRowHealth({ ...emptyRow(), source: "user_secret", userSecretKey: "gone" }, definitions)?.kind).toBe("missing");
    expect(computeUserSecretRowHealth({ ...emptyRow(), source: "user_secret", userSecretKey: "disabled" }, definitions)?.kind).toBe("disabled");
  });
});

describe("planSourceSwitch (§6.3)", () => {
  it("is a noop when the source is unchanged", () => {
    expect(planSourceSwitch({ ...emptyRow(), source: "text" }, "text")).toEqual({ kind: "noop" });
  });

  it("preserves a non-empty value on Text→Secret by opening the store popover", () => {
    const plan = planSourceSwitch({ ...emptyRow(), name: "GH_TOKEN", source: "text", textValue: "abc" }, "secret");
    expect(plan).toEqual({ kind: "open-store", name: "gh_token", value: "abc" });
  });

  it("switches straight to secret when the text value is empty", () => {
    expect(planSourceSwitch({ ...emptyRow(), source: "text", textValue: "  " }, "secret")).toEqual({ kind: "to-secret" });
  });

  it("offers undo on Secret→Text when a secret was bound", () => {
    const row = { ...emptyRow(), source: "secret" as const, secretId: "s1", version: 2 as const };
    const plan = planSourceSwitch(row, "text");
    expect(plan.kind).toBe("to-text");
    if (plan.kind === "to-text") expect(plan.undoFrom?.secretId).toBe("s1");
  });

  it("does not offer undo on Secret→Text when no secret was bound", () => {
    const plan = planSourceSwitch({ ...emptyRow(), source: "secret" }, "text");
    expect(plan).toEqual({ kind: "to-text", undoFrom: null });
  });
});

describe("name suggestion helpers", () => {
  it("secretNameFromKey lowercases to snake", () => {
    expect(secretNameFromKey("GH_TOKEN")).toBe("gh_token");
    expect(secretNameFromKey("Stripe-API-Key!")).toBe("stripe_api_key");
  });

  it("envKeyFromSecretName uppercases to snake", () => {
    expect(envKeyFromSecretName("github token")).toBe("GITHUB_TOKEN");
  });
});
