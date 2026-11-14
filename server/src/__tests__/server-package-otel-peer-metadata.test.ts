import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Infrastructure tracing providers and exporters remain optional peers.
 * Company connection tests use the resource utility and OTLP serializers as
 * regular dependencies, without creating a provider or enabling tracing.
 * `instrumentation.test.ts` guards opt-in provider initialization and fail-open
 * bootstrap when the optional provider packages are absent.
 */

const OPTIONAL_OTEL_PACKAGES = [
  "@opentelemetry/sdk-node",
  "@opentelemetry/auto-instrumentations-node",
  "@opentelemetry/semantic-conventions",
  "@opentelemetry/exporter-trace-otlp-grpc",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-trace-otlp-http",
] as const;

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

describe("server package OpenTelemetry peer metadata", () => {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    exports?: Record<string, unknown>;
    publishConfig?: { exports?: Record<string, unknown> };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  it.each(OPTIONAL_OTEL_PACKAGES)(
    "declares %s as an optional peer dependency",
    (packageName) => {
      expect(packageJson.peerDependencies?.[packageName]).toBeDefined();
      expect(packageJson.peerDependenciesMeta?.[packageName]?.optional).toBe(true);
    },
  );

  it.each(OPTIONAL_OTEL_PACKAGES)(
    "does not list %s in dependencies or devDependencies",
    (packageName) => {
      expect(packageJson.dependencies?.[packageName]).toBeUndefined();
      expect(packageJson.devDependencies?.[packageName]).toBeUndefined();
    },
  );

  it("keeps @opentelemetry/api as a normal dependency", () => {
    expect(packageJson.dependencies?.["@opentelemetry/api"]).toBeDefined();
    expect(packageJson.peerDependencies?.["@opentelemetry/api"]).toBeUndefined();
  });

  it("pins @opentelemetry/api inside the range the SDK packages peer-require", () => {
    // sdk-node@0.221.0 peer-requires @opentelemetry/api >=1.3.0 <1.10.0. A
    // caret range lets an install resolve 1.10.0, which then refuses the
    // registration of the SDK's 1.9.x copy and yields a no-op tracer.
    expect(packageJson.dependencies?.["@opentelemetry/api"]).toMatch(/^1\.9\.\d+$/);
  });

  it("exposes the otel-register preload entry in source and published exports", () => {
    expect(packageJson.exports?.["./otel-register"]).toBe("./src/otel-register.ts");
    expect(packageJson.publishConfig?.exports?.["./otel-register"]).toMatchObject({
      import: "./dist/otel-register.js",
    });
  });

  it.each(["@opentelemetry/resources", "@opentelemetry/otlp-transformer"])(
    "provides %s for explicit company connection tests",
    (packageName) => {
      expect(packageJson.dependencies?.[packageName]).toBeDefined();
    },
  );
});
