import { CONFIGURED_ENVIRONMENT_KEYS, configuredEnvironment, configuredEnvironmentProjection } from './configured-environment.js';
import { describe, expect, it, vi } from 'vitest';
import { createSanitizedCodexEnvironment } from './drivers/codex/app-server-transport.js';
import { createIsolatedCodexAppServerArgs } from './drivers/codex/codex-security-config.js';
import { createCapabilityRunnerdProviderEnvironment } from './live/runnerd-codex-transport.js';
import { spawnRunner } from './control-plane/durable-prp-control-plane.js';

const pages = {
  PAPERCLIP_PAGE_AWS_ACCESS_KEY_ID: 'fake-page-access-key',
  PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY: 'fake-page-secret',
  PAPERCLIP_PAGE_BUCKET: 'pages.example.test',
};
const source = { ...configuredEnvironmentProjection(pages), PATH: '/bin', ...pages, DATABASE_URL: 'host-secret-must-not-cross', NODE_OPTIONS: '--require=/untrusted/bootstrap.js', PAPERCLIP_API_KEY: 'controller-api-key-must-not-cross' };
const identity = { runnerInstanceId: 'runner-proof', environmentLeaseId: 'lease-proof', runId: 'run-proof', normalizedSessionId: 'session-proof', turnId: 'turn-proof', itemId: 'item-proof' };
function shellKeys() {
  const args = createIsolatedCodexAppServerArgs(source);
  const setting = args.find(value => value.startsWith('shell_environment_policy.include_only='))!;
  return { keys: JSON.parse(setting.slice(setting.indexOf('=') + 1)) as string[], serialized: args.join('\n') };
}

describe('controller-configured environment across native runner boundaries', () => {
  it('retains configured Pages values at the native Codex provider sanitizer', () => {
    expect(createSanitizedCodexEnvironment(source)).toMatchObject(pages);
  });
  it('retains configured Pages values when preparing a fresh runnerd process', () => {
    expect(createCapabilityRunnerdProviderEnvironment({ provider: 'codex', options: { environment: source }, identity, codexHome: '/isolated/codex-home', runtimeContextPath: '/isolated/runtime-context.json', hasRuntimeContext: false })).toMatchObject(pages);
  });
  it('passes configured Pages values through the runner spawn boundary', () => {
    let launched: NodeJS.ProcessEnv | undefined;
    spawnRunner({ connection: { mode: 'connect', connectUrl: 'ws://127.0.0.1:43127' }, stateDirectory: '/tmp/runner-env-proof', identity, ticket: 'fake-ticket', maxOutboxBytes: 262144, p0ReserveBytes: 65536, runnerVersion: '0.3.0', runnerDigest: `sha256:${'a'.repeat(64)}`, environment: source,
      processLauncher: spec => { launched = spec.environment; return { child: { pid: 42, exitCode: null, signalCode: null, kill: () => true }, completion: Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '' }) }; },
    });
    expect(launched).toMatchObject(pages);
    expect(launched!.DATABASE_URL).toBeUndefined();
    expect(launched!.NODE_OPTIONS).toBeUndefined();
    expect(launched!.PAPERCLIP_API_KEY).toBeUndefined();
  });
  it('allows configured Pages values into model-issued shell commands without serializing secrets into argv', () => {
    const { keys, serialized } = shellKeys();
    expect(keys).toEqual(expect.arrayContaining(Object.keys(pages)));
    expect(keys).not.toContain('DATABASE_URL');
    expect(keys).not.toContain('NODE_OPTIONS');
    expect(keys).not.toContain('PAPERCLIP_API_KEY');
    for (const value of Object.values(pages)) expect(serialized).not.toContain(value);
  });
  it('continues to exclude unbound ambient Pages credentials and host secrets', () => {
    vi.stubEnv('PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY', 'ambient-page-secret');
    try {
      expect(createSanitizedCodexEnvironment().PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY).toBeUndefined();
      const sanitized = createSanitizedCodexEnvironment(source);
      expect(sanitized.DATABASE_URL).toBeUndefined();
      expect(sanitized.NODE_OPTIONS).toBeUndefined();
      expect(sanitized.PAPERCLIP_API_KEY).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
});


describe("configured environment authority", () => {
  it("keeps selected bootstrap values in the environment rather than argv", () => {
    const environment = { PATH: "/bin", ...configuredEnvironmentProjection({ LANG: "configured-language-value" }) };
    const args = createIsolatedCodexAppServerArgs(environment);
    expect(args.join("\n")).not.toContain("configured-language-value");
    expect(args.find(arg => arg.startsWith("shell_environment_policy.include_only="))).toContain("LANG");
  });

  it("projects ordinary task credentials only when explicitly selected", () => {
    const projected = configuredEnvironmentProjection({ DATABASE_URL: "task-db", CUSTOM_FLAG: "on", NODE_OPTIONS: "unsafe", PAPERCLIP_API_KEY: "controller" });
    expect(createSanitizedCodexEnvironment(projected)).toMatchObject({ DATABASE_URL: "task-db", CUSTOM_FLAG: "on" });
    expect(projected.NODE_OPTIONS).toBeUndefined();
    expect(projected.PAPERCLIP_API_KEY).toBeUndefined();
  });

  it("does not accept an ambient projection in the provider or shell policy", () => {
    vi.stubEnv(CONFIGURED_ENVIRONMENT_KEYS, JSON.stringify(["PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY"]));
    vi.stubEnv("PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY", "ambient-secret");
    try {
      expect(createSanitizedCodexEnvironment().PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(createIsolatedCodexAppServerArgs().join("\n")).not.toContain("PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY");
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["not-json", "[1]", '["NODE_OPTIONS"]', '["PAPERCLIP_API_KEY"]', '["PAPERCLIP_RUNNER_BOOTSTRAP_TICKET"]', '["OPENAI_API_KEY"]', '["LD_PRELOAD"]', '["bad=name"]', '["CUSTOM","CUSTOM"]', '["MISSING"]'])
    ("rejects malformed or reserved projection %s", raw => {
      expect(() => configuredEnvironment({ [CONFIGURED_ENVIRONMENT_KEYS]: raw })).toThrow("Invalid configured environment");
    });

  it("rejects oversized and null-containing values without reporting their contents", () => {
    for (const value of ["x".repeat(65_536), "secret\0suffix"]) {
      expect(() => configuredEnvironmentProjection({ CUSTOM: value })).toThrow(/configured environment|Configured environment/);
    }
  });

  it("preserves configured values through ACPX and OpenCode preparation", async () => {
    const { createSanitizedAcpxSpawnInput } = await import("./drivers/acpx/environment.js");
    expect(createSanitizedAcpxSpawnInput(source, "codex").env).toMatchObject(pages);
    expect(createCapabilityRunnerdProviderEnvironment({ provider: "opencode", options: { environment: source }, identity, codexHome: "/isolated/home", runtimeContextPath: "/isolated/context", hasRuntimeContext: false })).toMatchObject(pages);
  });
});
