import { NextResponse } from "next/server";

/**
 * Performance timing utility for API routes
 * Adds Server-Timing headers to make performance metrics visible in browser DevTools
 */

interface TimingMetric {
  name: string;
  duration: number;
  description?: string;
}

/**
 * Track a timed operation and return its duration in milliseconds
 */
export async function measureAsync<T>(
  fn: () => Promise<T>
): Promise<[T, number]> {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;
  return [result, duration];
}

/**
 * Format timing metrics into Server-Timing header value
 * Format: name;dur=123.45;desc="Description"
 */
function formatServerTiming(metrics: TimingMetric[]): string {
  return metrics
    .map((m) => {
      const parts = [`${m.name};dur=${m.duration.toFixed(2)}`];
      if (m.description) {
        parts.push(`desc="${m.description}"`);
      }
      return parts.join(";");
    })
    .join(", ");
}

/**
 * Enhance a NextResponse with Server-Timing headers
 */
export function addTimingHeaders(
  response: NextResponse,
  metrics: TimingMetric[]
): NextResponse {
  if (metrics.length > 0) {
    const existingTiming = response.headers.get("Server-Timing");
    const newTiming = formatServerTiming(metrics);

    if (existingTiming) {
      response.headers.set("Server-Timing", `${existingTiming}, ${newTiming}`);
    } else {
      response.headers.set("Server-Timing", newTiming);
    }
  }

  return response;
}

/**
 * Wrapper for API route handlers that automatically tracks total execution time
 * and adds Server-Timing headers to the response
 *
 * @example
 * export const POST = withTiming(async (req) => {
 *   const [data, dbTime] = await measureAsync(() => db.select()...);
 *   return NextResponse.json({ data }, {
 *     timings: [{ name: "db", duration: dbTime, description: "Database query" }]
 *   });
 * });
 */
export function withTiming<T extends unknown[]>(
  handler: (...args: T) => Promise<NextResponse>
): (...args: T) => Promise<NextResponse> {
  return async (...args: T): Promise<NextResponse> => {
    const start = performance.now();
    const response = await handler(...args);
    const totalDuration = performance.now() - start;

    // Extract custom timings from response (if provided via custom property)
    const customTimings = (response as any)._timings as TimingMetric[] | undefined;

    const metrics: TimingMetric[] = [
      { name: "total", duration: totalDuration, description: "Total handler time" },
      ...(customTimings || []),
    ];

    return addTimingHeaders(response, metrics);
  };
}

/**
 * Helper to create a NextResponse with custom timing metrics
 * These will be picked up by withTiming wrapper
 */
export function jsonWithTimings(
  data: any,
  options: {
    status?: number;
    timings?: TimingMetric[];
    headers?: Record<string, string>;
  } = {}
): NextResponse {
  const response = NextResponse.json(data, {
    status: options.status,
    headers: options.headers,
  });

  if (options.timings) {
    (response as any)._timings = options.timings;
  }

  return response;
}
