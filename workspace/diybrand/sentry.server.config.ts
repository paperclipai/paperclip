import * as Sentry from "@sentry/nextjs";

export function initServerSentry() {
  if (!process.env.SENTRY_DSN) {
    console.warn("SENTRY_DSN not configured - error tracking disabled");
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    enabled: process.env.NODE_ENV === "production",

    // Performance Monitoring
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

    // Capture exceptions in API routes
    integrations: [
      new Sentry.Integrations.Http({
        tracing: true,
      }),
      new Sentry.Integrations.OnUncaughtException(),
      new Sentry.Integrations.OnUnhandledRejection(),
    ],

    // Release tracking
    release: process.env.VERCEL_GIT_COMMIT_SHA || "unknown",

    // Attach request data
    attachStacktrace: true,
    maxRequestBodySize: "medium",

    // Ignore specific errors
    ignoreErrors: [
      // Browser extension errors
      "chrome-extension://",
      "moz-extension://",
      // Network errors that are expected
      /NetworkError/,
      /Network request failed/,
    ],

    // Breadcrumb configuration
    maxBreadcrumbs: 100,
    beforeBreadcrumb: (breadcrumb) => {
      // Filter out noisy breadcrumbs
      if (breadcrumb.category === "console" && breadcrumb.level === "debug") {
        return null;
      }
      return breadcrumb;
    },
  });
}
