import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createConnectionProof } from "../connection-evidence.js";
import { retainOnboardingArtifact, validateOnboardingArtifact } from "./artifact-evidence.js";
import type { OnboardingArtifactEvidence } from "./types.js";

function fixture() {
  const proof = createConnectionProof();
  const bytes = Buffer.from(`${JSON.stringify(proof.expected, null, 2)}\n`);
  return retainOnboardingArtifact({ id: "attachment-1", originatingRunId: "run-1", bytes, proof });
}
function replaceBytes(receipt: OnboardingArtifactEvidence, bytes: Buffer) {
  receipt.contentBase64 = bytes.toString("base64");
  receipt.byteSize = bytes.byteLength;
  receipt.sha256 = createHash("sha256").update(bytes).digest("hex");
}

describe("private onboarding artifact receipt", () => {
  it("preserves the original formatted bytes and independently recomputable input oracle", () => {
    const receipt = fixture();
    const retained = JSON.parse(JSON.stringify(receipt));
    expect(() => validateOnboardingArtifact(retained)).not.toThrow();
    expect(Buffer.from(retained.contentBase64, "base64").toString("utf8")).toBe(`${JSON.stringify(retained.expected, null, 2)}\n`);
    const input = JSON.parse(retained.input);
    expect(retained.expected).toEqual({ nonce: input.nonce, count: input.values.length,
      total: input.values.reduce((sum:number, n:number) => sum + n, 0), sha256: createHash("sha256").update(retained.input).digest("hex") });
    expect(retained.sha256).not.toBe(retained.expected.sha256);
  });
  it("preserves equivalent escaped JSON and integer number representations accepted by the independent oracle", () => {
    const receipt = fixture();
    const escaped = (value: string) => value.split("").map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const bytes = Buffer.from(`{\n  "${escaped("sha256")}": "${escaped(receipt.expected.sha256)}",\n  "${escaped("total")}": ${receipt.expected.total}e0,\n  "${escaped("count")}": 7.0,\n  "${escaped("nonce")}": "${escaped(receipt.expected.nonce)}"\n}\n`);
    replaceBytes(receipt, bytes);
    expect(() => validateOnboardingArtifact(receipt)).not.toThrow();
    expect(Buffer.from(JSON.parse(JSON.stringify(receipt)).contentBase64, "base64")).toEqual(bytes);
  });
  it.each([
    ["changed download", (receipt: OnboardingArtifactEvidence) => { receipt.contentBase64 = Buffer.from("{}").toString("base64"); }],
    ["wrong declared size", (receipt: OnboardingArtifactEvidence) => { receipt.byteSize++; }],
    ["wrong download checksum", (receipt: OnboardingArtifactEvidence) => { receipt.sha256 = "0".repeat(64); }],
    ["noncanonical base64", (receipt: OnboardingArtifactEvidence) => { receipt.contentBase64 += "\n"; }],
    ["changed independent input", (receipt: OnboardingArtifactEvidence) => { receipt.input = receipt.input.replace("values", "privateValues"); }],
    ["matching but incorrect model result and expectation", (receipt: OnboardingArtifactEvidence) => {
      receipt.expected.total++;
      replaceBytes(receipt, Buffer.from(JSON.stringify(receipt.expected)));
    }],
    ["oversized whitespace", (receipt: OnboardingArtifactEvidence) => { replaceBytes(receipt, Buffer.from(`${" ".repeat(4096)}${JSON.stringify(receipt.expected)}`)); }],
    ["arbitrary agent output", (receipt: OnboardingArtifactEvidence) => { replaceBytes(receipt, Buffer.from(JSON.stringify({ ...receipt.expected, message: "unreviewed output" }))); }],
    ["discarded duplicate key text", (receipt: OnboardingArtifactEvidence) => {
      replaceBytes(receipt, Buffer.from(`{"nonce":"unreviewed output",${JSON.stringify(receipt.expected).slice(1)}`));
    }],
    ["escaped duplicate key text", (receipt: OnboardingArtifactEvidence) => {
      replaceBytes(receipt, Buffer.from(`{"\\u006eonce":"unreviewed output",${JSON.stringify(receipt.expected).slice(1)}`));
    }],
  ] as const)("rejects %s", (_name, mutate) => {
    const receipt = fixture();
    mutate(receipt);
    expect(() => validateOnboardingArtifact(receipt)).toThrow("invalid_onboarding_artifact_evidence");
  });
  it("rejects additional receipt fields rather than retaining arbitrary metadata", () => {
    expect(() => validateOnboardingArtifact({ ...fixture(), requestHeaders: {} })).toThrow("invalid_onboarding_artifact_evidence");
    const receipt = fixture();
    Object.assign(receipt.expected, { message: "unreviewed output" });
    expect(() => validateOnboardingArtifact(receipt)).toThrow("invalid_onboarding_artifact_evidence");
  });
});
