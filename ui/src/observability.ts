// Client-side observability: Sentry (errors + session replay on error) and PostHog (product
// analytics + replay). Both no-op when their env var is absent, so the app runs unchanged until
// the keys are set. These are VITE_* vars — baked at build time (set them in the Vercel build env).
import * as Sentry from "@sentry/react";
import posthog from "posthog-js";

const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
  });
}

const posthogKey = import.meta.env.VITE_PUBLIC_POSTHOG_KEY?.trim();
if (posthogKey) {
  posthog.init(posthogKey, {
    api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,
  });
}

export { posthog };
