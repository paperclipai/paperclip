import { createHash } from "node:crypto";
import { type createConnectionProof, verifyConnectionArtifact } from "../connection-evidence.js";
import type { OnboardingArtifactEvidence } from "./types.js";

const maxBytes = 4096;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value &&
  typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key)));
function fail(): never { throw new Error("invalid_onboarding_artifact_evidence"); }

export function validateOnboardingArtifact(value: unknown): asserts value is OnboardingArtifactEvidence {
  if (!exactKeys(value, ["schema", "id", "originatingRunId", "filename", "byteSize", "sha256", "contentBase64", "input", "expected"])) fail();
  const receipt = value as unknown as OnboardingArtifactEvidence;
  if (receipt.schema !== "paperclip.product-journey.artifact/v1" || receipt.filename !== "connection-proof.json" ||
    ![receipt.id, receipt.originatingRunId].every(id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)) ||
    !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize < 1 || receipt.byteSize > maxBytes ||
    typeof receipt.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
    typeof receipt.contentBase64 !== "string" || receipt.contentBase64.length > Math.ceil(maxBytes / 3) * 4 ||
    typeof receipt.input !== "string" || receipt.input.length > 1024 ||
    !exactKeys(receipt.expected, ["nonce", "count", "total", "sha256"])) fail();
  const bytes = Buffer.from(receipt.contentBase64, "base64");
  if (bytes.toString("base64") !== receipt.contentBase64 || bytes.byteLength !== receipt.byteSize || hash(bytes) !== receipt.sha256) fail();
  let input: unknown;
  try { input = JSON.parse(receipt.input); } catch { fail(); }
  if (!exactKeys(input, ["nonce", "values"]) || typeof input.nonce !== "string" || !/^[a-f0-9]{24}$/.test(input.nonce) ||
    !Array.isArray(input.values) || input.values.length !== 7 ||
    !input.values.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 65535)) fail();
  const expected = { nonce: input.nonce, count: input.values.length, total: input.values.reduce((sum, n) => sum + n, 0), sha256: hash(receipt.input) };
  if (receipt.input !== `${JSON.stringify({ nonce: input.nonce, values: input.values })}\n` ||
    Object.entries(expected).some(([key, entry]) => receipt.expected[key as keyof typeof expected] !== entry) ||
    !verifyConnectionArtifact(bytes, expected)) fail();
  const compact = bytes.toString("utf8").replace(/[ \t\r\n]/g, "");
  const pairs = compact.slice(1, -1).split(",");
  if (!compact.startsWith("{") || !compact.endsWith("}") || pairs.length !== Object.keys(expected).length) fail();
  const seen = new Set<string>();
  for (const pair of pairs) {
    let field: unknown;
    try { field = JSON.parse(`{${pair}}`); } catch { fail(); }
    if (!field || typeof field !== "object" || Array.isArray(field) || Object.keys(field).length !== 1) fail();
    const [key, entry] = Object.entries(field)[0]!;
    if (!Object.hasOwn(expected, key) || seen.has(key) || entry !== expected[key as keyof typeof expected]) fail();
    seen.add(key);
  }
}

export function retainOnboardingArtifact(input: {
  id: string; originatingRunId: string; bytes: Buffer; proof: ReturnType<typeof createConnectionProof>;
}): OnboardingArtifactEvidence {
  const receipt: OnboardingArtifactEvidence = {
    schema: "paperclip.product-journey.artifact/v1", id: input.id, originatingRunId: input.originatingRunId,
    filename: "connection-proof.json", byteSize: input.bytes.byteLength, sha256: hash(input.bytes),
    contentBase64: input.bytes.toString("base64"), input: input.proof.input,
    expected: { ...input.proof.expected },
  };
  validateOnboardingArtifact(receipt);
  return receipt;
}
