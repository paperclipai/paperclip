export function crewbriefPosthogService(
  apiKey?: string,
  host?: string,
  umamiUrl?: string,
  umamiWebsiteId?: string,
) {
  const url = umamiUrl || "http://127.0.0.1:3456";
  const websiteId = umamiWebsiteId || "e69396ab-6b76-4d2b-8e4a-778337f8bca4";
  const enabled = !!apiKey || !!url;

  async function capture(
    event: string,
    distinctId: string,
    properties?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await fetch(`${url}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event",
          payload: {
            website: websiteId,
            url: "/api/capture",
            event_name: event,
            hostname: "crewbrief.avva.aero",
            data: { distinct_id: distinctId, ...properties },
          },
        }),
      });
    } catch (err) {
      console.warn(`[crewbrief-posthog] failed to capture event "${event}":`, (err as Error).message);
    }
  }

  async function identify(
    distinctId: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    try {
      await fetch(`${url}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "identify",
          payload: {
            website: websiteId,
            user: { id: distinctId },
            data: properties,
          },
        }),
      });
    } catch (err) {
      console.warn(`[crewbrief-posthog] failed to identify user "${distinctId}":`, (err as Error).message);
    }
  }

  async function alias(
    alias: string,
    distinctId: string,
  ): Promise<void> {
  }

  async function flush(): Promise<void> {
  }

  return {
    enabled,
    capture,
    identify,
    alias,
    flush,
  };
}

export type CrewbriefPosthogService = ReturnType<typeof crewbriefPosthogService>;
