import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { prepareIsolatedCodexHome } from "./runtime-context-materializer.js";
import { AGENT_OBSERVABILITY_ENV_KEYS, applyProviderObservabilityEnvironment, providerObservabilityEnvironment, redactObservabilityDiagnostic, type ProviderObservabilityLaunch } from "./agent-observability.js";
import { createSanitizedAcpxSpawnInput } from "./acpx/environment.js";
import { configuredEnvironmentProjection } from "../configured-environment.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const launch: ProviderObservabilityLaunch = { kind: "codex", compatibilityKey: "revision", environment: {
  OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "3000",
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=Bearer%20secret-canary",
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Bearer%20secret-canary",
}, otelConfig: {
  exporter: { "otlp-http": { endpoint: "https://collector.example/v1/logs", protocol: "binary", headers: {} } }, metrics_exporter: "none", log_agent_responses: true,
} };
it("transports a valid encoded header set in both Codex exporters without rejecting the launch", () => {
  const headers = Object.fromEntries([0, 1, 2, 3].map(index => [`x-custom-${index}`, encodeURIComponent("%".repeat(4000))]));
  const exporter = { "otlp-http": { headers } };
  const value = JSON.stringify({ exporter, trace_exporter: exporter });
  expect(Buffer.byteLength(value)).toBeGreaterThan(65536);
  expect(providerObservabilityEnvironment({ PAPERCLIP_OBSERVABILITY_CODEX_CONFIG: value }, "codex")).toEqual({ PAPERCLIP_OBSERVABILITY_CODEX_CONFIG: value });
  expect(() => providerObservabilityEnvironment({ PAPERCLIP_OBSERVABILITY_CODEX_CONFIG: "x".repeat(128 * 1024 + 1) }, "codex")).toThrow("Invalid observability launch environment");
});
it("materializes the real native home with both governed MCP and protected export config", async () => {
  const home = await mkdtemp(join(tmpdir(), "paperclip-native-otel-")); roots.push(home);
  await mkdir(join(home, "source"));
  await writeFile(join(home, "source", "auth.json"), '{"OPENAI_API_KEY":"fixture"}');
  await prepareIsolatedCodexHome({ context: null, codexHome: home, sourceCodexHome: join(home, "source"), observability: launch,
    nativeMcp: { name: "paperclip-assigned", url: "https://paperclip.example/mcp", token: "mcp-secret" } });
  const config = parse(await readFile(join(home, "config.toml"), "utf8"));
  expect(config.otel).toEqual(launch.otelConfig); expect(config.mcp_servers).toHaveProperty("paperclip-assigned");
  expect(JSON.stringify(config)).not.toContain("secret-canary");
  expect((await stat(join(home, "config.toml"))).mode & 0o777).toBe(0o600);
});
it("delivers Codex headers only through its provider environment and redacts diagnostics", () => {
  const source = applyProviderObservabilityEnvironment({ KEEP: "task" }, launch, true);
  const sanitized = createSanitizedAcpxSpawnInput(source, "codex").env;
  expect(sanitized).toMatchObject(launch.environment);
  expect(sanitized.PAPERCLIP_OBSERVABILITY_CODEX_CONFIG).not.toContain("secret-canary");
  expect(configuredEnvironmentProjection(source).PAPERCLIP_CONFIGURED_ENV_KEYS).toBe('["KEEP"]');
  expect(createSanitizedAcpxSpawnInput(source, "pi").env).not.toHaveProperty("OTEL_EXPORTER_OTLP_LOGS_HEADERS");
  const diagnostic = redactObservabilityDiagnostic("Bearer secret-canary Bearer%20secret-canary secret-canary", sanitized);
  expect(diagnostic).toBe("[REDACTED] [REDACTED] [REDACTED]");
});
it("passes only explicit Claude observability through its sanitizer and excludes task projection", () => {
  const source = { OTEL_LOGS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=Bearer%20secret-canary", KEEP: "task" };
  expect(createSanitizedAcpxSpawnInput(source, "claude").env).toMatchObject({ OTEL_LOGS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_LOGS_HEADERS: source.OTEL_EXPORTER_OTLP_LOGS_HEADERS });
  expect(createSanitizedAcpxSpawnInput(source, "pi").env).not.toHaveProperty("OTEL_EXPORTER_OTLP_LOGS_HEADERS");
  const projected = configuredEnvironmentProjection(source);
  expect(projected.PAPERCLIP_CONFIGURED_ENV_KEYS).toBe('["KEEP"]');
  expect(redactObservabilityDiagnostic("export authorization=Bearer secret-canary", source)).not.toContain("secret-canary");
});
it("clears stale launch values and serializes Codex only for its trusted ACPX process", () => {
  const environment = applyProviderObservabilityEnvironment({ OTEL_EXPORTER_OTLP_HEADERS: "stale" }, launch, true);
  expect(environment).not.toHaveProperty("OTEL_EXPORTER_OTLP_HEADERS");
  expect(environment.PAPERCLIP_OBSERVABILITY_CODEX_CONFIG).toBe(JSON.stringify(launch.otelConfig));
  expect(AGENT_OBSERVABILITY_ENV_KEYS).toContain("PAPERCLIP_OBSERVABILITY_CODEX_CONFIG");
});
it("redacts encoded Codex header values and their decoded transport form", () => {
  const raw = "Bearer arbitrary%26secret,with=punctuation";
  const config = { exporter: { "otlp-http": { headers: { authorization: encodeURIComponent(raw) } } } };
  const diagnostic = redactObservabilityDiagnostic(`${raw} ${raw.slice(7)} ${encodeURIComponent(raw)}`, {}, config);
  expect(diagnostic).toBe("[REDACTED] [REDACTED] [REDACTED]");
});
