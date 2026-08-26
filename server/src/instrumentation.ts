// Optional OpenTelemetry auto-instrumentation for HTTP / Express / PG / …
//
// Activated only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. When unset, no
// OTel packages are loaded at all.
//
// The imports are dynamic and the packages are treated as optional runtime
// dependencies — self-hosters who want tracing install them explicitly.
// That keeps OTel off the default dependency graph and avoids forcing a
// lockfile bump for an opt-in feature.
//
// The exporter protocol is selected via the standard `OTEL_EXPORTER_OTLP_PROTOCOL`
// env var (per the OTLP spec):
//   - `grpc` (or unset)  → @opentelemetry/exporter-trace-otlp-grpc   [default]
//   - `http/protobuf`    → @opentelemetry/exporter-trace-otlp-proto
//   - `http/json`        → @opentelemetry/exporter-trace-otlp-http
// Any other value logs a warning and falls back to grpc.
//
// Before it imports any package, the bootstrap checks the four common
// packages and the selected exporter against the exact versions this
// manifest's `peerDependencies` declare. A missing or a mismatched version
// logs one diagnostic and leaves the server running without tracing; it
// never throws.
//
// Timing guarantee: the bootstrap is async (dynamic imports), so it cannot
// patch modules "before they are evaluated" — by the time the first await
// yields, index.ts's static imports (http, express, pg) are already loaded.
// What this module guarantees instead is `instrumentationReady`: the SDK has
// started (or failed and logged) before that promise resolves. index.ts
// awaits it at the top of `startServer()`, so tracing is active before any
// DB connection is opened or the HTTP server is constructed — the patching
// that matters happens at call time, not import time. Spans are flushed on
// exit via `shutdownInstrumentation()`, which index.ts awaits in its signal
// handler before `process.exit`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

let sdkShutdown: (() => Promise<void>) | null = null;
let shutdownPromise: Promise<void> | null = null;

/**
 * A minimal, structural span/tracer surface. It is the subset of the
 * `@opentelemetry/api` `Span` / `Tracer` shape that the startup timing seam
 * calls. A real OTel tracer satisfies it. The no-op fallback below implements
 * it too, so the caller never needs a null check.
 */
interface StartupTracerHandle {
  startSpan(
    name: string,
    options?: unknown,
    // The optional explicit parent-context token. A real OTel
    // `startSpan(name, options, context)` parents the new span to the span that
    // `context` carries. The no-op tracer ignores it. The exec seam passes the
    // active step context here, so an exec span parents to its step span.
    context?: unknown,
  ): {
    setAttribute(key: string, value: unknown): void;
    setStatus(status: { code: number; message?: string }): void;
    // The optional explicit end time as an epoch-millisecond number. A real OTel
    // `span.end(endTime)` uses it as the span end time, so the span shows its
    // true wall-clock width. The no-op span ignores it.
    end(endTime?: unknown): void;
  };
}

const NOOP_SPAN = {
  setAttribute() {},
  setStatus() {},
  end() {},
};

/**
 * The no-op tracer returned when `@opentelemetry/api` is absent or a lookup
 * fails. It opens a span that does nothing, so startup tracing stays a no-op
 * without an installed OTel package.
 */
const NOOP_TRACER: StartupTracerHandle = {
  startSpan: () => NOOP_SPAN,
};

let tracerApiLoadFailed = false;

/**
 * Return a startup tracer. When `@opentelemetry/api` is installed, it returns
 * `trace.getTracer(name)`. The `api` package itself returns a no-op tracer
 * while no SDK is registered, so an unset endpoint still yields a safe no-op
 * without loading any OTel SDK package. The api package loads lazily through
 * `require`, so the module graph stays OTel-free until the first call. The
 * accessor never throws: a load or lookup failure logs once and returns the
 * local no-op tracer (fail open).
 */
export function getStartupTracer(name = "paperclip.startup"): StartupTracerHandle {
  try {
    const require = createRequire(import.meta.url);
    const api = require("@opentelemetry/api") as {
      trace?: { getTracer(n: string): StartupTracerHandle };
    };
    const tracer = api.trace?.getTracer(name);
    return tracer ?? NOOP_TRACER;
  } catch (err) {
    if (!tracerApiLoadFailed) {
      tracerApiLoadFailed = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[paperclip] @opentelemetry/api is not available; startup tracing uses a no-op tracer.",
        err,
      );
    }
    return NOOP_TRACER;
  }
}

/**
 * The injected tracer plus the one context helper the ACPX engine needs. The
 * engine opens a root span, then builds a parent-context token from it through
 * `contextWithSpan`, and forwards that token to each child span. The token
 * comes from `trace.setSpan(context.active(), span)`, so the engine never
 * imports `@opentelemetry/api`.
 */
export interface StartupTraceContextHandle {
  readonly tracer: StartupTracerHandle;
  contextWithSpan(span: unknown): unknown;
}

/**
 * The no-op trace context returned when `@opentelemetry/api` is absent or a
 * lookup fails. Its tracer is a no-op and it produces no parent token, so
 * startup tracing stays a no-op without an installed OTel package.
 */
const NOOP_TRACE_CONTEXT: StartupTraceContextHandle = {
  tracer: NOOP_TRACER,
  contextWithSpan: () => undefined,
};

let traceContextApiLoadFailed = false;

/**
 * Return a startup trace context (tracer + root parent-context helper). When
 * `@opentelemetry/api` is installed, the tracer is `trace.getTracer(name)` and
 * `contextWithSpan(span)` returns `trace.setSpan(context.active(), span)`. The
 * `api` package returns a no-op tracer while no SDK is registered, so an unset
 * endpoint still yields a safe no-op. The `api` package loads lazily through
 * `require`, so the module graph stays OTel-free until the first call. The
 * accessor never throws: a load or lookup failure logs once and returns the
 * local no-op trace context (fail open).
 */
export function getStartupTraceContext(name = "paperclip.startup"): StartupTraceContextHandle {
  try {
    const require = createRequire(import.meta.url);
    const api = require("@opentelemetry/api") as {
      trace?: {
        getTracer(n: string): StartupTracerHandle;
        setSpan(context: unknown, span: unknown): unknown;
      };
      context?: { active(): unknown };
    };
    const trace = api.trace;
    const context = api.context;
    if (!trace?.getTracer || !trace.setSpan || !context?.active) {
      return NOOP_TRACE_CONTEXT;
    }
    const tracer = trace.getTracer(name);
    return {
      tracer,
      // Keep the method calls on `trace` / `context` so the api singletons stay
      // their own receiver.
      contextWithSpan: (span: unknown) => trace.setSpan(context.active(), span),
    };
  } catch (err) {
    if (!traceContextApiLoadFailed) {
      traceContextApiLoadFailed = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[paperclip] @opentelemetry/api is not available; startup tracing uses a no-op trace context.",
        err,
      );
    }
    return NOOP_TRACE_CONTEXT;
  }
}

/**
 * The parsed parts of a W3C `traceparent`. The host builds a remote parent span
 * context from these parts to parent a plugin span to the active host span.
 */
export interface ParsedTraceparent {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

/**
 * Serialize an OTel context token to a W3C `traceparent` string. The host passes
 * the token to the plugin worker per call, so the worker's provider span can
 * parent to the active host span. The function reads the span context from the
 * token and formats it by hand, so it needs no registered propagator. It returns
 * `undefined` when `@opentelemetry/api` is absent, when the token holds no span
 * context, or when the span context is invalid.
 */
export function traceparentFromContextToken(contextToken: unknown): string | undefined {
  if (contextToken === undefined || contextToken === null) return undefined;
  try {
    const require = createRequire(import.meta.url);
    const api = require("@opentelemetry/api") as {
      trace?: { getSpanContext(context: unknown): { traceId: string; spanId: string; traceFlags: number } | undefined };
    };
    const spanContext = api.trace?.getSpanContext?.(contextToken);
    if (!spanContext) return undefined;
    const { traceId, spanId, traceFlags } = spanContext;
    if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) return undefined;
    const flags = (traceFlags & 0xff).toString(16).padStart(2, "0");
    return `00-${traceId}-${spanId}-${flags}`;
  } catch {
    return undefined;
  }
}

/**
 * Record a plugin-originated provider span through the real tracer, parented to
 * a host span. The host handler validates and clamps the span data first (the
 * trust boundary), then passes the parsed parent and the clamped attributes
 * here. This function only does the OTel plumbing: it builds a remote parent
 * span context, opens the span, sets its attributes and status, and ends it. It
 * is a no-op when `@opentelemetry/api` is absent (the endpoint is unset) or when
 * the parent parts are invalid. It never throws — observability must not change
 * control flow.
 */
export function recordProviderPluginSpan(input: {
  name: string;
  parent: ParsedTraceparent;
  attributes: Record<string, string | number | boolean>;
  status?: { code: number; message?: string };
  /** The optional span start time as an epoch-millisecond number. When present
   * with `endTimeMs`, the span shows its true wall-clock width. When absent, the
   * span opens and ends synchronously, so its native width is near zero. */
  startTimeMs?: number;
  /** The optional span end time as an epoch-millisecond number. */
  endTimeMs?: number;
}): void {
  try {
    const require = createRequire(import.meta.url);
    const api = require("@opentelemetry/api") as {
      trace?: {
        getTracer(n: string): StartupTracerHandle;
        setSpanContext(context: unknown, spanContext: unknown): unknown;
      };
      context?: { active(): unknown };
    };
    const trace = api.trace;
    const context = api.context;
    if (!trace?.getTracer || !trace.setSpanContext || !context?.active) return;
    const remoteSpanContext = {
      traceId: input.parent.traceId,
      spanId: input.parent.spanId,
      traceFlags: input.parent.traceFlags,
      isRemote: true,
    };
    const parentContext = trace.setSpanContext(context.active(), remoteSpanContext);
    const tracer = trace.getTracer("paperclip.startup");
    // Pass the true start time as the OpenTelemetry `startTime` option, so the
    // span opens at its real wall-clock start. An epoch-millisecond number is a
    // valid OpenTelemetry `TimeInput`.
    const startSpanOptions =
      input.startTimeMs !== undefined
        ? { attributes: input.attributes, startTime: input.startTimeMs }
        : { attributes: input.attributes };
    const span = tracer.startSpan(input.name, startSpanOptions, parentContext);
    if (input.status) span.setStatus(input.status);
    // Pass the true end time to `span.end`, so the span ends at its real
    // wall-clock end and shows its true native width. When the end time is
    // absent, the span ends now, so its native width is near zero.
    if (input.endTimeMs !== undefined) span.end(input.endTimeMs);
    else span.end();
  } catch {
    // Observability must not change control flow.
  }
}

/**
 * The four OTel packages that every protocol needs, regardless of which
 * exporter `OTEL_EXPORTER_OTLP_PROTOCOL` selects. `bootstrapOtel` reads this
 * synchronously (before its first `await`), so it must be declared above
 * `instrumentationReady`: that export calls `bootstrapOtel` at module-init
 * time, and a `const` declared below it is not yet initialized then.
 */
const OTEL_COMMON_PACKAGES = [
  "@opentelemetry/sdk-node",
  "@opentelemetry/auto-instrumentations-node",
  "@opentelemetry/resources",
  "@opentelemetry/semantic-conventions",
] as const;

/**
 * Resolves once the OTel SDK has started (or once bootstrap has failed and
 * logged, or immediately when the feature is off). Await before constructing
 * the HTTP server so trace coverage doesn't depend on incidental timing.
 */
export const instrumentationReady: Promise<void> = endpoint
  ? bootstrapOtel(endpoint)
  : Promise.resolve();

/**
 * Flush buffered spans and stop the SDK. Idempotent — concurrent callers
 * share one shutdown. No-op when tracing is off or bootstrap failed.
 */
export function shutdownInstrumentation(): Promise<void> {
  shutdownPromise ??= (async () => {
    await instrumentationReady;
    if (!sdkShutdown) return;
    try {
      // Awaiting matters: the SDK flushes buffered spans to the collector
      // during shutdown; exiting before it settles silently drops them.
      await sdkShutdown();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[paperclip] OpenTelemetry shutdown failed", err);
    }
  })();
  return shutdownPromise;
}

type ExporterProtocol = "grpc" | "http/protobuf" | "http/json";

export function resolveProtocol(): {
  protocol: ExporterProtocol;
  packageName: string;
} {
  const raw = process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim().toLowerCase();
  switch (raw) {
    case undefined:
    case "":
    case "grpc":
      return {
        protocol: "grpc",
        packageName: "@opentelemetry/exporter-trace-otlp-grpc",
      };
    case "http/protobuf":
      return {
        protocol: "http/protobuf",
        packageName: "@opentelemetry/exporter-trace-otlp-proto",
      };
    case "http/json":
      return {
        protocol: "http/json",
        packageName: "@opentelemetry/exporter-trace-otlp-http",
      };
    default:
      // eslint-disable-next-line no-console
      console.warn(
        `[paperclip] Unknown OTEL_EXPORTER_OTLP_PROTOCOL=${raw}; falling back to grpc. ` +
          `Valid values: grpc, http/protobuf, http/json.`,
      );
      return {
        protocol: "grpc",
        packageName: "@opentelemetry/exporter-trace-otlp-grpc",
      };
  }
}

/**
 * Read this package's own `peerDependencies`, so the exact-version gate
 * compares an installed package against the same version this manifest
 * declares — one source of truth, not a second hardcoded copy. Returns an
 * empty map on any read or parse failure (fail open: an unreadable manifest
 * skips the version check rather than blocking startup).
 */
function readOwnPeerDependencies(): Record<string, string> {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = readFileSync(pkgUrl, "utf8");
    const parsed = JSON.parse(raw) as { peerDependencies?: Record<string, string> };
    return parsed.peerDependencies ?? {};
  } catch {
    return {};
  }
}

/**
 * Read an installed package's own declared `version`, without importing or
 * executing the package. Resolves the package's main entry point (which
 * respects its `exports` map) and then walks up the filesystem to the
 * nearest `package.json` whose `name` matches — a direct
 * `require.resolve(\`${packageName}/package.json\`)` throws for a package
 * whose `exports` map does not expose `./package.json` as a subpath, which
 * several `@opentelemetry/*` packages do not, even though the package is
 * correctly installed. Returns null when the package cannot be resolved or no
 * matching `package.json` is found.
 */
function readInstalledPackageVersion(packageName: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve(packageName));
    for (;;) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (parsed.name === packageName) {
          return typeof parsed.version === "string" ? parsed.version : null;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/**
 * Verify that every package in `packageNames` is installed at the exact
 * version `peerDependencies` declares. Checks only the packages the caller
 * passes in — the bootstrap passes the four common packages plus the one
 * exporter `OTEL_EXPORTER_OTLP_PROTOCOL` selected, never the two unselected
 * exporters. Never throws: a missing manifest, a missing package, or an
 * unreadable `package.json` all resolve to a reported issue, not an
 * exception.
 *
 * `peerDependencies` defaults to this manifest's own declared versions
 * (`readOwnPeerDependencies()`), which is what the bootstrap uses. A test
 * passes an explicit map instead, so it can check the comparison logic
 * against a package it controls without writing into `node_modules`.
 */
export function checkExactPeerVersions(
  packageNames: readonly string[],
  peerDependencies: Record<string, string> = readOwnPeerDependencies(),
): { ok: true } | { ok: false; diagnostic: string; detail: unknown } {
  const missing: string[] = [];
  const mismatched: { name: string; installed: string; expected: string }[] = [];

  for (const name of packageNames) {
    const expected = peerDependencies[name];
    const installed = readInstalledPackageVersion(name);
    if (installed === null) {
      missing.push(name);
    } else if (expected && installed !== expected) {
      mismatched.push({ name, installed, expected });
    }
  }

  if (missing.length === 0 && mismatched.length === 0) return { ok: true };

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`the @opentelemetry/* packages are not installed: ${missing.join(", ")}`);
  }
  if (mismatched.length > 0) {
    const detail = mismatched
      .map((m) => `${m.name}@${m.installed} (expected ${m.expected})`)
      .join(", ");
    parts.push(`a package is installed at an unsupported version: ${detail}`);
  }

  return {
    ok: false,
    diagnostic:
      `[paperclip] OTEL_EXPORTER_OTLP_ENDPOINT is set but ${parts.join("; and ")}. ` +
      "Continuing without tracing.",
    detail: { missing, mismatched },
  };
}

async function importExporter(protocol: ExporterProtocol): Promise<{
  OTLPTraceExporter: new (config?: Record<string, unknown>) => unknown;
}> {
  switch (protocol) {
    case "grpc":
      // @ts-ignore optional peer dep
      return await import("@opentelemetry/exporter-trace-otlp-grpc");
    case "http/protobuf":
      // @ts-ignore optional peer dep
      return await import("@opentelemetry/exporter-trace-otlp-proto");
    case "http/json":
      // @ts-ignore optional peer dep
      return await import("@opentelemetry/exporter-trace-otlp-http");
  }
}

/**
 * Read the commit SHA from the build stamp. The server `build` script writes
 * `dist/build-info.json` next to the compiled module. Return the SHA, or null
 * when the stamp is absent or unreadable. In `tsx` dev mode the module runs
 * from `src`, where no stamp exists, so this returns null and the caller falls
 * back to a runtime git lookup.
 */
export function readBuildStamp(): string | null {
  try {
    const stampUrl = new URL("./build-info.json", import.meta.url);
    const raw = readFileSync(stampUrl, "utf8");
    const parsed = JSON.parse(raw) as { commit?: unknown };
    if (typeof parsed.commit === "string" && parsed.commit.length > 0) {
      return parsed.commit;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the current commit SHA with `git rev-parse --short HEAD`. Return the
 * SHA, or null on any failure. This covers dev mode, where the process runs
 * from a git checkout. A missing `git` or a checkout with no `.git` returns
 * null and is not fatal.
 *
 * The lookup runs in the directory of this module, not the directory the
 * server process started in. `import.meta.url` points at `src` in dev mode and
 * `dist` in a built server; both sit inside the Paperclip checkout. A server
 * launched from an unrelated directory, or from inside another repository,
 * would otherwise report a wrong commit or fall back.
 */
export function readGitCommit(): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: new URL("./", import.meta.url),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the `service.version` span attribute. The order is:
 *   1. The build stamp — the commit the running server was built from.
 *   2. A runtime git lookup — covers `tsx src/index.ts` dev mode.
 *   3. The `OTEL_SERVICE_VERSION` environment variable.
 *   4. "unknown".
 * The build stamp wins over the environment variable, so a stale
 * `OTEL_SERVICE_VERSION` cannot mask the true built commit. `OTEL_SERVICE_VERSION`
 * is a Paperclip-specific variable, not an OpenTelemetry SDK variable, so
 * Paperclip controls this precedence.
 */
export function resolveServiceVersion(
  buildStamp: string | null,
  gitCommit: string | null,
  envVersion: string | undefined,
): string {
  return buildStamp || gitCommit || envVersion || "unknown";
}

async function bootstrapOtel(endpoint: string): Promise<void> {
  const { protocol, packageName: exporterPackage } = resolveProtocol();

  // Gate on exact peer versions before touching a single dynamic import: a
  // package installed at the wrong version can still load and start, then
  // fail in a way the operator only sees in the collector, not the server
  // log. Checking first turns that into one precise, fail-open diagnostic.
  const versionCheck = checkExactPeerVersions([...OTEL_COMMON_PACKAGES, exporterPackage]);
  if (!versionCheck.ok) {
    // eslint-disable-next-line no-console
    console.warn(versionCheck.diagnostic, versionCheck.detail);
    return;
  }

  try {
    // Dynamic imports so type-resolution doesn't require the packages to
    // be installed unless the operator actually opts in.
    const [sdkNode, autoInstr, traceExporter, resources, semconv] =
      await Promise.all([
        // @ts-ignore optional peer dep
        import("@opentelemetry/sdk-node"),
        // @ts-ignore optional peer dep
        import("@opentelemetry/auto-instrumentations-node"),
        importExporter(protocol),
        // @ts-ignore optional peer dep
        import("@opentelemetry/resources"),
        // @ts-ignore optional peer dep
        import("@opentelemetry/semantic-conventions"),
      ]);

    const { NodeSDK } = sdkNode;
    const { getNodeAutoInstrumentations } = autoInstr;
    const { OTLPTraceExporter } = traceExporter;
    const { resourceFromAttributes } = resources;
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = semconv;

    const serviceVersion = resolveServiceVersion(
      readBuildStamp(),
      readGitCommit(),
      process.env.OTEL_SERVICE_VERSION,
    );
    // Log the resolved value once so an operator can confirm the built commit.
    // eslint-disable-next-line no-console
    console.log(`[paperclip] OpenTelemetry service.version=${serviceVersion}`);

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "paperclip",
        [ATTR_SERVICE_VERSION]: serviceVersion,
      }),
      // For the HTTP protocols OTEL_EXPORTER_OTLP_ENDPOINT is a *base* URL
      // and the exporter appends /v1/traces only when it reads the env var
      // itself — an explicit `url` is used verbatim and would silently POST
      // to the wrong path. Pass `url` only for gRPC, which has no path.
      // `importExporter` types `OTLPTraceExporter` as `=> unknown` so the
      // module graph stays free of the optional OTLP/SDK packages. Without
      // that type, `traceExporter` needs `SpanExporter`, and an import of
      // `SpanExporter` breaks the compile when the optional packages are
      // absent. Cast to `never` instead: `never` is assignable to
      // `SpanExporter` and needs no import.
      traceExporter: (protocol === "grpc"
        ? new OTLPTraceExporter({ url: endpoint })
        : new OTLPTraceExporter()) as never,
      instrumentations: [
        getNodeAutoInstrumentations({
          // Too chatty for this workload.
          "@opentelemetry/instrumentation-fs": { enabled: false },
          "@opentelemetry/instrumentation-dns": { enabled: false },
          "@opentelemetry/instrumentation-net": { enabled: false },
        }),
      ],
    });

    try {
      sdk.start();
    } catch (err) {
      // A bad gRPC endpoint, missing native bindings, or a collector that
      // rejects the SDK's handshake should not take down the server.
      // eslint-disable-next-line no-console
      console.error(
        "[paperclip] OpenTelemetry SDK failed to start; continuing without tracing",
        err,
      );
      return;
    }

    sdkShutdown = () =>
      Promise.race([
        sdk.shutdown(),
        // The SDK waits indefinitely for in-flight export batches; an
        // unreachable collector must not block process exit. 5s matches the
        // SDK's own default flush budget. unref() so the timer itself never
        // keeps the event loop alive after a fast clean shutdown.
        new Promise<void>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("OTel shutdown timed out")), 5_000);
          timer.unref?.();
        }),
      ]);
    // index.ts awaits shutdownInstrumentation() in its own signal handler
    // before process.exit, which is what actually guarantees the flush.
    // These handlers are a backstop for entrypoints that import this module
    // without coordinating; shutdownInstrumentation() is idempotent, so the
    // two paths share a single flush.
    process.once("SIGTERM", () => void shutdownInstrumentation());
    process.once("SIGINT", () => void shutdownInstrumentation());
  } catch (err) {
    // The exact-version gate above already confirmed every checked package is
    // installed at the declared version, so only a load failure after that
    // point reaches this block: a bad build, a broken native binding, or a
    // package that throws during its own module init. Fall through with a
    // single diagnostic so the opt-in path is self-documenting.
    // eslint-disable-next-line no-console
    console.warn(
      "[paperclip] OTEL_EXPORTER_OTLP_ENDPOINT is set and the @opentelemetry/* " +
        "packages passed the version check, but one of them failed to load. " +
        "Continuing without tracing.",
      err,
    );
  }
}
