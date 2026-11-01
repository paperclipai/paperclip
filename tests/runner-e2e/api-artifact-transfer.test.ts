import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { artifactTransferDescription, gradeApiArtifactTransfer } from "./api-artifact-transfer.js";

describe("verified API artifact transfer evidence", () => {
  const description = artifactTransferDescription("fixture");
  const content = JSON.stringify({ id: "source-issue", description });
  const sha256 = createHash("sha256").update(content).digest("hex");
  const identity = { artifactId: "source-artifact", byteSize: Buffer.byteLength(content), sha256 };
  const proof = { content, sha256 };
  const event = (eventType: string, payload: unknown) => ({ eventType, payload: { prpEvent: { payload } } });
  const call = (id: string, name: string, input: unknown, result: unknown) => [
    event("item.started", { item: { id, type: "tool_use", name, input } }),
    event("item.completed", { item: { id, type: "tool_result", tool_use_id: id, result } }),
    event("tool.execution.completed", { name, executionId: id, status: "completed" }),
  ];
  const source = () => call("read", "call_api", {
    operationId: "GET /api/issues/{id}", pathParams: { id: "source-issue" },
  }, {
    ok: true, status: 200, apiOperationId: "GET /api/issues/{id}",
    artifact: { ...identity, url: "/api/assets/source-artifact/content" },
  });
  const install = (input = {}, result = {}) => call("install", "download_artifact", {
    ...identity, destination: "api-response-proof.txt", ...input,
  }, { outcome: "completed", ...identity, destination: "api-response-proof.txt", ...result });
  const grade = (events = [...source(), ...install()], attachment = proof) =>
    gradeApiArtifactTransfer(events, "source-issue", attachment, description);

  it("uses exactly 388131 source bytes with multibyte and escaped content", () => {
    expect(Buffer.byteLength(description)).toBe(388131);
    expect(description).toContain('snowman ☃, quote ", backslash \\');
  });
  it("requires the source capture, actual installation and independently downloaded bytes", () => {
    expect(grade()).toMatchObject({ passed: true, sha256, byteSize: Buffer.byteLength(content) });
  });
  it("rejects a correct file without completed installation evidence", () => {
    expect(grade(source()).passed).toBe(false);
    expect(grade([...source(), ...install().filter(entry => entry.eventType !== "tool.execution.completed")]).passed).toBe(false);
  });
  it.each([
    { artifactId: "other-artifact" }, { destination: "other.txt" },
    { byteSize: identity.byteSize - 1 }, { sha256: "0".repeat(64) },
  ])("rejects mismatched installation input %j", input => {
    expect(grade([...source(), ...install(input)]).passed).toBe(false);
  });
  it.each([
    { outcome: "unknown" }, { outcome: "failed" }, { artifactId: "other-artifact" },
    { byteSize: identity.byteSize - 1 }, { sha256: "0".repeat(64) }, { destination: "other.txt" },
  ])("rejects an unconfirmed or mismatched receipt %j", result => {
    expect(grade([...source(), ...install({}, result)]).passed).toBe(false);
  });
  it("rejects one lost byte even with consistent attachment metadata", () => {
    const damaged = JSON.stringify({ id: "source-issue", description: description.slice(1) });
    expect(grade(undefined, { content: damaged, sha256: createHash("sha256").update(damaged).digest("hex") }).passed).toBe(false);
  });
  it("rejects another source, incomplete JSON, and a false digest", () => {
    expect(grade(undefined, { content: JSON.stringify({ id: "other", description }), sha256 }).passed).toBe(false);
    expect(grade(undefined, { content: content.slice(1), sha256 }).passed).toBe(false);
    expect(grade(undefined, { content, sha256: "0".repeat(64) }).passed).toBe(false);
  });
  it("rejects an installation whose completion belongs to another tool", () => {
    const wrong = install();
    wrong[2] = event("tool.execution.completed", { name: "call_api", executionId: "install", status: "completed" });
    expect(grade([...source(), ...wrong]).passed).toBe(false);
  });
});
