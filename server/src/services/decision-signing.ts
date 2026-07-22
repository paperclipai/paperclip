import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = "decision-spec-v1";

function secret() {
  const value = process.env.PAPERCLIP_DECISION_SIGNING_SECRET?.trim();
  if (!value || value.length < 32) throw new Error("PAPERCLIP_DECISION_SIGNING_SECRET is required");
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function signDecisionSpec(value: unknown) {
  return `${VERSION}.${createHmac("sha256", secret()).update(`${VERSION}:${canonical(value)}`).digest("hex")}`;
}

export function verifyDecisionSpec(value: unknown, signature: string) {
  const expected = Buffer.from(signDecisionSpec(value));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
