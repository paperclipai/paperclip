// Next.js instrumentation hook — runs once per server process at startup.
// GLA-989: kicks off the IssueDocument auto-comment poller.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
