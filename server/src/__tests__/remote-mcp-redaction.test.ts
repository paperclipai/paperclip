import { describe, expect, it } from "vitest";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";

describe("public Executor selectors and secret redaction", () => {
  it("keeps only exact known public helper addresses readable in MCP results", () => {
    const path = "executor.coreTools.integrations.list";
    expect(redactEventPayload({ path, text: `Call tools.${path}({})` })).toEqual({ path, text: `Call tools.${path}({})` });
    expect(redactSensitiveText(`${path}.privateSecretSuffix`)).toContain("REDACTED");
    expect(redactEventPayload({ path: "arbitrary.provider.path" })?.path).toContain("REDACTED");
  });
  it("still redacts secret fields, bearer values, and JWT-shaped strings", () => {
    const value = "executor.coreTools.integrations.list";
    expect(redactEventPayload({ token: value })?.token).toContain("REDACTED");
    expect(redactSensitiveText(`Authorization: Bearer ${value}`)).not.toContain(value);
    expect(redactSensitiveText(`TOKEN=${value}`)).not.toContain(value);
    expect(redactSensitiveText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345678")).toContain("REDACTED");
  });
});
