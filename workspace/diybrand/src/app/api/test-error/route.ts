import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

/**
 * Test endpoint for validating Sentry error capture
 *
 * Usage (production only):
 * curl https://diybrand.app/api/test-error?type=exception
 *
 * Types:
 * - exception: Throw an error
 * - message: Send a message to Sentry
 * - performance: Trigger a performance issue
 */
export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get("type") || "message";

  // Only allow in production for testing
  const isDevelopment = process.env.NODE_ENV === "development";

  if (!isDevelopment && process.env.SENTRY_DSN) {
    switch (type) {
      case "exception":
        // Capture an exception
        throw new Error("Test error from /api/test-error");

      case "message":
        // Capture a message
        Sentry.captureMessage("Test message from /api/test-error", "info");
        break;

      case "performance":
        // Simulate a slow operation
        const startTime = Date.now();
        while (Date.now() - startTime < 2000) {
          // Artificial delay
        }
        Sentry.captureMessage("Slow operation completed", "warning");
        break;

      default:
        return NextResponse.json(
          { error: 'Invalid type. Use: "exception", "message", or "performance"' },
          { status: 400 }
        );
    }

    return NextResponse.json({
      message: "Test event sent to Sentry",
      type,
      sentry: {
        dsn: process.env.SENTRY_DSN?.split("@")[1] || "not configured",
        environment: process.env.NODE_ENV,
      },
    });
  }

  return NextResponse.json(
    {
      message: "Sentry not configured or in development mode",
      isDevelopment,
      hasDSN: !!process.env.SENTRY_DSN,
    },
    { status: 503 }
  );
}
