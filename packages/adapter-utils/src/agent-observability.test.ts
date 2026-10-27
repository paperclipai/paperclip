import { afterEach, expect, it } from "vitest";
import { lstat, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { DEFAULT_AGENT_OBSERVABILITY_CAPTURE } from "@paperclipai/shared";
import { buildProviderObservabilityLaunch, applyObservabilityEnvironment, observabilitySecretValues } from "./agent-observability.js";
import { prepareCodexObservabilityProfile, replaceCodexProfileArgs, selectedCodexProfile, disableCodexObservabilityArgs } from "./codex-observability-profile.js";
import { buildInvocationEnvForLogs } from "./server-utils.js";
import { prepareAcpxCodexObservabilityHome } from "./codex-observability-home.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const input = { companyId: "company", agentId: "agent", revision: "revision", compatibilityKey: "version", enabled: true,
  capture: { ...DEFAULT_AGENT_OBSERVABILITY_CAPTURE }, logsEndpoint: "https://collector.example/v1/logs", tracesEndpoint: "https://collector.example/v1/traces", headers: { authorization: "Bearer a,b=c% d" } };
it("encodes headers losslessly and clears ambient exporter conflicts without changing host state", () => {
  const launch = buildProviderObservabilityLaunch({ ...input, kind: "claude" });
  const env = { OTEL_EXPORTER_OTLP_HEADERS: "ambient", OTEL_EXPORTER_OTLP_ENDPOINT: "https://wrong", KEEP: "ok" };
  applyObservabilityEnvironment(env, launch);
  expect(env).not.toHaveProperty("OTEL_EXPORTER_OTLP_HEADERS");
  expect(env).toHaveProperty("KEEP", "ok");
  const encoded = launch.environment.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
  expect(decodeURIComponent(encoded.slice(encoded.indexOf("=") + 1))).toBe(input.headers.authorization);
  expect(observabilitySecretValues(launch)).toContain(input.headers.authorization);
  expect(JSON.stringify(buildInvocationEnvForLogs({ ...launch.environment }))).not.toContain("a%2Cb");
});
it("keeps Codex headers in the launch environment and preserves literal percent sequences", () => {
  const original = "Bearer a,b=%26 c%";
  const launch = buildProviderObservabilityLaunch({ ...input, kind: "codex", headers: { authorization: original } });
  const exporter = launch.otelConfig!.exporter as { "otlp-http": { headers: Record<string, string> } };
  expect(exporter["otlp-http"].headers).toEqual({});
  for (const key of ["OTEL_EXPORTER_OTLP_LOGS_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"]) {
    expect(launch.environment[key]).toBe(`authorization=${encodeURIComponent(original)}`);
  }
  expect(JSON.stringify(launch.otelConfig)).not.toContain(original);
  expect(JSON.stringify(launch.otelConfig)).not.toContain(encodeURIComponent(original));
  expect(observabilitySecretValues(launch)).toContain(original);
  expect(observabilitySecretValues(launch)).toContain(encodeURIComponent(original));
  expect(observabilitySecretValues(launch)).toContain(original.slice(7));
  expect(JSON.stringify(buildInvocationEnvForLogs({ ...launch.environment }))).not.toContain("a%2Cb");
  const disabled = buildProviderObservabilityLaunch({ ...input, kind: "codex", enabled: false });
  expect(disabled.environment).not.toHaveProperty("OTEL_EXPORTER_OTLP_LOGS_HEADERS");
  expect(disabled.environment).not.toHaveProperty("OTEL_EXPORTER_OTLP_TRACES_HEADERS");
});
it("replaces a compact explicit profile without leaving competing profile flags", () => {
  const args = ["exec", "-preview", "-"];
  expect(selectedCodexProfile(args)).toBe("review");
  replaceCodexProfileArgs(args, "generated");
  expect(args).toEqual(["--profile", "generated", "exec", "-"]);
});
it("keeps an explicit source profile while disabling export after preparation fails", () => {
  const args = ["--profile", "review", "exec", "-"];
  disableCodexObservabilityArgs(args);
  expect(selectedCodexProfile(args)).toBe("review");
  expect(args).toContain('otel.exporter="none"');
  expect(args).toContain('otel.trace_exporter="none"');
  expect(args).toContain('otel.metrics_exporter="none"');
});
it("creates invocation-owned profiles, preserves selected profile settings, and restores by deleting only its own file", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-otel-profile-")); roots.push(root);
  await writeFile(join(root, "review.config.toml"), 'model = "chosen-model"\n[otel]\nexporter = "none"\n');
  const launch = buildProviderObservabilityLaunch({ ...input, kind: "codex" });
  const a = await prepareCodexObservabilityProfile({ home: root, runId: "run-a", sourceProfile: "review", launch });
  const b = await prepareCodexObservabilityProfile({ home: root, runId: "run-b", launch });
  const parsed = parse(await readFile(join(root, a.filename), "utf8"));
  expect(JSON.stringify(parsed)).not.toContain(input.headers.authorization);
  expect(JSON.stringify(parsed)).not.toContain(encodeURIComponent(input.headers.authorization));
  expect(parsed.model).toBe("chosen-model");
  expect(parsed.otel).toMatchObject({ log_agent_responses: true, tool_result: { max_bytes: 65536 } });
  expect((await stat(join(root, a.filename))).mode & 0o777).toBe(0o600);
  const args = ["exec", "--profile=review", "resume", "session", "-"];
  replaceCodexProfileArgs(args, a.name);
  expect(args).toEqual(["--profile", a.name, "exec", "resume", "session", "-"]);
  await a.cleanup();
  expect(await readFile(join(root, b.filename), "utf8")).toContain("otel");
  expect(await readFile(join(root, "review.config.toml"), "utf8")).toContain('exporter = "none"');
});
it("isolates overlapping ACPX export settings while sharing the saved provider conversation", async () => {
  const home = await mkdtemp(join(tmpdir(), "paperclip-acpx-otel-")); roots.push(home);
  await writeFile(join(home, "config.toml"), 'model = "retained-model"\n');
  const first = buildProviderObservabilityLaunch({ ...input, kind: "codex", compatibilityKey: "first" });
  const second = buildProviderObservabilityLaunch({ ...input, kind: "codex", compatibilityKey: "second", enabled: false });
  const otherAgent = buildProviderObservabilityLaunch({ ...input, kind: "codex", compatibilityKey: "first", agentId: "other-agent" });
  const [a, b, c] = await Promise.all([
    prepareAcpxCodexObservabilityHome(home, first, input.agentId),
    prepareAcpxCodexObservabilityHome(home, second, input.agentId),
    prepareAcpxCodexObservabilityHome(home, otherAgent, "other-agent"),
  ]);
  expect(a).not.toBe(c);
  expect(parse(await readFile(join(a, "config.toml"), "utf8")).otel).toMatchObject({ span_attributes: { "paperclip.agent.id": input.agentId } });
  expect(parse(await readFile(join(c, "config.toml"), "utf8")).otel).toMatchObject({ span_attributes: { "paperclip.agent.id": "other-agent" } });
  await writeFile(join(a, "sessions", "saved-conversation.jsonl"), "conversation checkpoint");
  expect(await readFile(join(b, "sessions", "saved-conversation.jsonl"), "utf8")).toBe("conversation checkpoint");
  expect(parse(await readFile(join(a, "config.toml"), "utf8")).otel).toMatchObject({ log_agent_responses: true });
  expect(parse(await readFile(join(b, "config.toml"), "utf8")).otel).toMatchObject({ exporter: "none" });
  expect(parse(await readFile(join(a, "config.toml"), "utf8")).model).toBe("retained-model");
  expect(await readFile(join(home, "config.toml"), "utf8")).toBe('model = "retained-model"\n');
  expect((await stat(a)).mode & 0o777).toBe(0o700);
  expect((await stat(join(a, "config.toml"))).mode & 0o777).toBe(0o600);
});

it.each([true, false])("preserves refreshed Codex credentials across repeated and replacement preparations with export %s", async enabled => {
  const home = await mkdtemp(join(tmpdir(), "paperclip-acpx-auth-")); roots.push(home);
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { refresh_token: "old-fixture-token" } }), { mode: 0o600 });
  const launch = buildProviderObservabilityLaunch({ ...input, enabled, kind: "codex" });
  const first = await prepareAcpxCodexObservabilityHome(home, launch, input.agentId);
  expect((await lstat(join(first, "auth.json"))).isSymbolicLink()).toBe(true);
  expect(await readlink(join(first, "auth.json"))).toBe(join(home, "auth.json"));
  await writeFile(join(first, "auth.json"), JSON.stringify({ tokens: { refresh_token: "refreshed-fixture-token" } }));
  expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8")).tokens.refresh_token).toBe("refreshed-fixture-token");
  const repeated = await prepareAcpxCodexObservabilityHome(home, launch, input.agentId);
  const replacement = await prepareAcpxCodexObservabilityHome(home, { ...launch, compatibilityKey: "replacement" }, input.agentId);
  for (const prepared of [repeated, replacement]) {
    expect(JSON.parse(await readFile(join(prepared, "auth.json"), "utf8")).tokens.refresh_token).toBe("refreshed-fixture-token");
  }
});
