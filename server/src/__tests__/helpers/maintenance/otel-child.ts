import { getStartupTracer, instrumentationReady, shutdownInstrumentation } from '../../../instrumentation.js';
await instrumentationReady;
const span = getStartupTracer('paperclip.sleep-qualification').startSpan('sleep-qualification-stimulus');
span.end();
// Keep the real SDK alive beyond its 60s default metric-reader interval. This
// observes unwanted exporter traffic without disabling any exporter through env.
if (process.argv.includes('--observe-exporters')) {
  await new Promise(resolve => setTimeout(resolve, 90_000));
}
await shutdownInstrumentation();
