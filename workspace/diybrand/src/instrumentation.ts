export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initServerSentry } = await import("../sentry.server.config");
    initServerSentry();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    const { initClientSentry } = await import("../sentry.client.config");
    initClientSentry();
  }
}
