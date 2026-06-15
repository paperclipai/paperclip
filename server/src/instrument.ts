// Sentry server init. Imported FIRST in index.ts (before anything else) so Sentry can
// instrument http/express on both planes (Vercel control plane + Railway worker). No-op when
// SENTRY_DSN is unset, so the server runs unchanged until the DSN is configured in env.
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "production",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    sendDefaultPii: false,
  });
}
