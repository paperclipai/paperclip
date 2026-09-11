export const PUBLIC_RUNNER_SCREENSHOT_MARKER = "public-runner-fixture" as const;

export interface PublicRunnerScreenshotTarget {
  issuePrefix: string | null | undefined;
  issueId: string | null | undefined;
  issueIdentifier: string | null | undefined;
}

export function isPublicRunnerScreenshotRoute(
  url: string,
  target: PublicRunnerScreenshotTarget,
) {
  try {
    if (!target.issuePrefix || !target.issueId) return false;
    const candidate = new URL(url);
    const issueReference = target.issueIdentifier ?? target.issueId;
    const expectedPath = `/${encodeURIComponent(target.issuePrefix)}/issues/${encodeURIComponent(issueReference)}`;
    return (
      candidate.protocol === "http:" &&
      candidate.hostname === "127.0.0.1" &&
      (candidate.pathname === expectedPath ||
        candidate.pathname === `${expectedPath}/`)
    );
  } catch {
    return false;
  }
}
