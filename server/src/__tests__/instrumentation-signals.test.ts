import { afterEach, expect, it, vi } from 'vitest';
import { InMemorySpanExporter, TracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace';

const sdk = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>>, start: vi.fn(), shutdown: vi.fn(async () => {}) }));
vi.mock('../peer-version-check.js', () => ({ checkExactPeerVersions: () => ({ ok: true }) }));
vi.mock('@opentelemetry/sdk-node', async () => {
  const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace');
  return { tracing: { BatchSpanProcessor: class extends BatchSpanProcessor {
    constructor(exporter: InMemorySpanExporter) { super({ exporter }); }
  } }, NodeSDK: class {
  constructor(options: Record<string, unknown>) { sdk.options.push(options); }
  start = sdk.start;
  shutdown = sdk.shutdown;
  } };
});
vi.mock('@opentelemetry/auto-instrumentations-node', () => ({ getNodeAutoInstrumentations: () => [] }));
vi.mock('@opentelemetry/resources', () => ({ resourceFromAttributes: (attributes: unknown) => attributes }));
vi.mock('@opentelemetry/semantic-conventions', () => ({ ATTR_SERVICE_NAME: 'service.name', ATTR_SERVICE_VERSION: 'service.version' }));
let capturedExporter: InMemorySpanExporter;
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class extends InMemorySpanExporter {
    constructor() { super(); capturedExporter = this; }
  },
}));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it('configures current plural SDK signal options so an opted-in trace exporter cannot enable default metrics or logs', async () => {
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector.invalid:4318');
  vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json');
  vi.spyOn(process, 'once').mockReturnValue(process);
  vi.resetModules();
  const instrumentation = await import('../instrumentation.js');
  await instrumentation.instrumentationReady;
  expect(sdk.options).toHaveLength(1);
  expect(sdk.options[0]).toMatchObject({ metricReaders: [], logRecordProcessors: [], traceExporter: expect.any(Object) });
  expect(sdk.options[0]).not.toHaveProperty('metricReader');
  expect(sdk.options[0]).not.toHaveProperty('logRecordProcessor');
  expect(sdk.start).toHaveBeenCalledOnce();
  await instrumentation.shutdownInstrumentation();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
});

it('labels spans with the current public hostname after an identity change', async () => {
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector.invalid:4318');
  vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json');
  vi.stubEnv('PAPERCLIP_TRACING_INSTANCE_HOST', 'true');
  vi.stubEnv('PAPERCLIP_PUBLIC_URL', 'https://first.example.com/private?q=query');
  vi.spyOn(process, 'once').mockReturnValue(process);
  vi.resetModules();
  const instrumentation = await import('../instrumentation.js');
  await instrumentation.instrumentationReady;
  const provider = new TracerProvider({ spanProcessors: sdk.options.at(-1)!.spanProcessors as SpanProcessor[] });
  try {
    const tracer = provider.getTracer('test');
    tracer.startSpan('first').end();
    vi.stubEnv('PAPERCLIP_PUBLIC_URL', 'https://second.example.com');
    tracer.startSpan('second').end();
    vi.stubEnv('PAPERCLIP_PUBLIC_URL', 'invalid');
    tracer.startSpan('invalid').end();
    await provider.forceFlush();
    expect(capturedExporter.getFinishedSpans().map(s => s.attributes['paperclip.instance.host']))
      .toEqual(['first.example.com', 'second.example.com', undefined]);
  } finally {
    await provider.shutdown();
  }
  await instrumentation.shutdownInstrumentation();
});
