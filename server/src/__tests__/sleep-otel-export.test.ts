import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { it, expect } from 'vitest';
import { withMaintenanceProvider } from './helpers/maintenance/server-harness.js';

// Opt-in qualification must fail when the SDK falls back to no-op. The ordinary
// bootstrap tests separately retain coverage for the supported missing-peer mode.
it.skipIf(process.env.PAPERCLIP_SLEEP_CONFIGURED_ACCEPTANCE !== '1')('exports an actual named span with no metric or log traffic over 90 real seconds', async () => {
  const spans: string[] = [], paths: string[] = [];
  const collector = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    paths.push(req.url ?? 'missing-path');
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    for (const resource of envelope.resourceSpans ?? []) for (const scope of resource.scopeSpans ?? []) for (const span of scope.spans ?? []) spans.push(span.name);
    res.setHeader('Content-Type', 'application/json'); res.end('{}');
  });
  await withMaintenanceProvider(collector, async origin => {
    const startedAt = performance.now();
    const { stderr } = await promisify(execFile)(process.execPath, ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./helpers/maintenance/otel-child.ts', import.meta.url)), '--observe-exporters'], {
      env: { PATH: process.env.PATH, NODE_ENV: 'production', OTEL_EXPORTER_OTLP_ENDPOINT: origin, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' },
      timeout: 110_000, maxBuffer: 2 * 1024 * 1024,
    });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(90_000);
    expect(stderr).not.toContain('Continuing without tracing');
    expect(spans).toContain('sleep-qualification-stimulus');
    expect(paths).not.toContain('/v1/metrics');
    expect(paths).not.toContain('/v1/logs');
  });
}, 120_000);


it('keeps the optional SDK and exporters inactive without an endpoint', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url)),
    fileURLToPath(new URL('./helpers/maintenance/otel-child.ts', import.meta.url))], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production' }, timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
  expect(stdout).not.toContain('OpenTelemetry service.version=');
  expect(stderr).not.toContain('Continuing without tracing');
});
