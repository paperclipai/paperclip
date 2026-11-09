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

  it.each(["@opentelemetry/resources", "@opentelemetry/otlp-transformer"])(
    "provides %s for explicit company connection tests",
    (packageName) => {
      expect(packageJson.dependencies?.[packageName]).toBeDefined();
    },
  );
});
