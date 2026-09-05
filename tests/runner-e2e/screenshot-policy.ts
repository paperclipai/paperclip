export const PUBLIC_RUNNER_SCREENSHOT_MARKER = "public-runner-fixture" as const;

export function isPublicRunnerScreenshotRoute(url: string) {
  try {
    const candidate = new URL(url);
    return (
      candidate.protocol === "http:" &&
      candidate.hostname === "127.0.0.1" &&
      /^\/[^/]+\/issues\/[^/]+\/?$/.test(candidate.pathname)
    );
  } catch {
    return false;
  }
}
