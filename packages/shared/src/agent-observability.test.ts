import { expect, it } from "vitest";
import { updateAgentObservabilitySchema, DEFAULT_AGENT_OBSERVABILITY_CAPTURE, normalizeOtlpBaseUrl } from "./agent-observability.js";
const request = { expectedRevision: null, enabled: true, destination: { provider: "otlp", endpointBaseUrl: "https://collector.example/otel/" }, credentials: { mode: "replace", headers: [] } };
it("defaults capture and normalizes a path-prefixed anonymous collector", () => {
  expect(updateAgentObservabilitySchema.parse(request)).toMatchObject({ capture: DEFAULT_AGENT_OBSERVABILITY_CAPTURE, destination: { endpointBaseUrl: "https://collector.example/otel" } });
});
it.each(["ftp://collector.example", "https://secret@collector.example", "https://collector.example?token=secret", "https://collector.example/#fragment", "https://collector.example/v1/logs"])("rejects ambiguous or credential-bearing endpoint %s", url => {
  expect(() => normalizeOtlpBaseUrl(url)).toThrow();
});
it.each([
  [{ name: "Authorization", value: "valid" }, { name: "authorization", value: "duplicate" }],
  [{ name: "host", value: "forged" }], [{ name: "x-auth", value: "a\r\nb" }],
  [{ name: "x-auth", value: "[REDACTED]" }], [{ name: "x-auth", value: "é".repeat(2049) }],
  [{ name: "x-auth", value: "\ud800" }], [{ name: "x-auth", value: "\udc00" }],
].map(headers => ({ headers })))("rejects invalid headers", ({ headers }) => {
  expect(updateAgentObservabilitySchema.safeParse({ ...request, credentials: { mode: "replace", headers } }).success).toBe(false);
});
it("rejects provider credential mismatches and unknown fields", () => {
  expect(updateAgentObservabilitySchema.safeParse({ ...request, credentials: { mode: "replace", apiKey: "key" } }).success).toBe(false);
  expect(updateAgentObservabilitySchema.safeParse({ ...request, injected: "value" }).success).toBe(false);
});
