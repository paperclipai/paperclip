import * as Sentry from "@sentry/nextjs";

export function initClientSentry() {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) {
    console.warn("NEXT_PUBLIC_SENTRY_DSN not configured - error tracking disabled");
    return;
  }

  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    enabled: process.env.NODE_ENV === "production",

    // Performance Monitoring
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

    // Release tracking
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || "unknown",

    // Capture user information
    initialScope: {
      tags: {
        component: "web",
      },
    },

    // Ignore specific errors
    ignoreErrors: [
      // Browser extension errors
      "chrome-extension://",
      "moz-extension://",
      // Network/CORS errors
      /NetworkError/,
      /Network request failed/,
      /Failed to fetch/,
      /Fetch error/,
    ],

    // Breadcrumb configuration
    maxBreadcrumbs: 50,
    beforeBreadcrumb: (breadcrumb) => {
      // Filter out noisy breadcrumbs
      if (breadcrumb.category === "console" && breadcrumb.level === "debug") {
        return null;
      }
      return breadcrumb;
    },
  });
}
