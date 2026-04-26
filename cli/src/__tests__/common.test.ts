import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeContext } from "../client/context.js";
import { formatInlineRecord, resolveCommandContext } from "../commands/client/common.js";

const ORIGINAL_ENV = { ...process.env };

function createTempPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-common-"));
  return path.join(dir, name);
}

describe("resolveCommandContext", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_COMPANY_ID;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses profile defaults when options/env are not provided", () => {
    const contextPath = createTempPath("context.json");

    writeContext(
      {
        version: 1,
        currentProfile: "ops",
        profiles: {
          ops: {
            apiBase: "http://127.0.0.1:9999",
            companyId: "company-profile",
            apiKeyEnvVarName: "AGENT_KEY",
          },
        },
      },
      contextPath,
    );
    process.env.AGENT_KEY = "key-from-env";

    const resolved = resolveCommandContext({ context: contextPath }, { requireCompany: true });
    expect(resolved.api.apiBase).toBe("http://127.0.0.1:9999");
    expect(resolved.companyId).toBe("company-profile");
    expect(resolved.api.apiKey).toBe("key-from-env");
  });

  it("prefers explicit options over profile values", () => {
    const contextPath = createTempPath("context.json");
    writeContext(
      {
        version: 1,
        currentProfile: "default",
        profiles: {
          default: {
            apiBase: "http://profile:3100",
            companyId: "company-profile",
          },
        },
      },
      contextPath,
    );

    const resolved = resolveCommandContext(
      {
        context: contextPath,
        apiBase: "http://override:3200",
        apiKey: "direct-token",
        companyId: "company-override",
      },
      { requireCompany: true },
    );

    expect(resolved.api.apiBase).toBe("http://override:3200");
    expect(resolved.companyId).toBe("company-override");
    expect(resolved.api.apiKey).toBe("direct-token");
  });

  it("throws when company is required but unresolved", () => {
    const contextPath = createTempPath("context.json");
    writeContext(
      {
        version: 1,
        currentProfile: "default",
        profiles: { default: {} },
      },
      contextPath,
    );

    expect(() =>
      resolveCommandContext({ context: contextPath, apiBase: "http://localhost:3100" }, { requireCompany: true }),
    ).toThrow(/Company ID is required/);
  });
});

// ---------------------------------------------------------------------------
// formatInlineRecord
// ---------------------------------------------------------------------------

describe("formatInlineRecord", () => {
  it("formats a record with known priority keys first", () => {
    const result = formatInlineRecord({ id: "abc-123", name: "My Agent", status: "active" });
    // id comes before name in keyOrder
    expect(result.indexOf("id=")).toBeLessThan(result.indexOf("name="));
    expect(result.indexOf("name=")).toBeLessThan(result.indexOf("status="));
  });

  it("includes all string fields in the output", () => {
    const result = formatInlineRecord({ identifier: "PAP-1", title: "Fix bug", status: "todo" });
    expect(result).toContain("identifier=PAP-1");
    expect(result).toContain("title=Fix bug");
    expect(result).toContain("status=todo");
  });

  it("renders null values as a dash", () => {
    const result = formatInlineRecord({ id: "x", name: null });
    expect(result).toContain("name=-");
  });

  it("renders undefined values as a dash", () => {
    const result = formatInlineRecord({ id: "x", priority: undefined });
    expect(result).toContain("priority=-");
  });

  it("renders boolean values as strings", () => {
    const result = formatInlineRecord({ id: "x", active: true, archived: false });
    expect(result).toContain("active=true");
    expect(result).toContain("archived=false");
  });

  it("renders numeric values as strings", () => {
    const result = formatInlineRecord({ id: "x", count: 42 });
    expect(result).toContain("count=42");
  });

  it("omits object-typed values from the output", () => {
    const result = formatInlineRecord({ id: "x", nested: { a: 1 } });
    expect(result).not.toContain("nested=");
    expect(result).toContain("id=x");
  });

  it("truncates long string values to 90 characters with ellipsis", () => {
    const longTitle = "A".repeat(100);
    const result = formatInlineRecord({ title: longTitle });
    expect(result).toContain("...");
    const valueStart = result.indexOf("title=") + "title=".length;
    const value = result.slice(valueStart);
    expect(value.length).toBeLessThanOrEqual(93); // 87 chars + "..." = 90
  });

  it("does not truncate strings at or under 90 characters", () => {
    const exactly90 = "B".repeat(90);
    const result = formatInlineRecord({ title: exactly90 });
    expect(result).not.toContain("...");
    expect(result).toContain(`title=${exactly90}`);
  });

  it("collapses whitespace in string values", () => {
    const result = formatInlineRecord({ title: "Hello   World\n\tFoo" });
    expect(result).toContain("title=Hello World Foo");
  });

  it("returns empty string for an empty record", () => {
    const result = formatInlineRecord({});
    expect(result).toBe("");
  });

  it("places identifier before id when both present", () => {
    const result = formatInlineRecord({ id: "abc", identifier: "PAP-1", title: "My title" });
    expect(result.indexOf("identifier=")).toBeLessThan(result.indexOf("id="));
  });

  it("places priority before title in keyOrder", () => {
    const result = formatInlineRecord({ title: "Bug fix", priority: "high" });
    expect(result.indexOf("priority=")).toBeLessThan(result.indexOf("title="));
  });

  it("includes non-priority string keys after priority keys", () => {
    const result = formatInlineRecord({ id: "x", customField: "hello" });
    expect(result).toContain("customField=hello");
    expect(result.indexOf("id=")).toBeLessThan(result.indexOf("customField="));
  });

  it("separates key=value pairs with spaces", () => {
    const result = formatInlineRecord({ id: "1", name: "Alice" });
    expect(result).toMatch(/id=\S+ name=\S+/);
  });
});
