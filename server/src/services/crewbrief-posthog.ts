const POSTHOG_API_BASE = "https://app.posthog.com";

export function crewbriefPosthogService(apiKey?: string, host?: string) {
  const baseUrl = host || POSTHOG_API_BASE;
  const enabled = !!apiKey;

  async function capture(
    event: string,
    distinctId: string,
    properties?: Record<string, unknown>,
  ): Promise<void> {
    if (!enabled) return;
    try {
      await fetch(`${baseUrl}/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          event,
          distinct_id: distinctId,
          properties: {
            $lib: "posthog-node",
            ...properties,
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
    if (!enabled) return;
    try {
      await fetch(`${baseUrl}/identify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          distinct_id: distinctId,
          properties,
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
    if (!enabled) return;
    try {
      await fetch(`${baseUrl}/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          event: "$create_alias",
          distinct_id: distinctId,
          properties: { alias },
        }),
      });
    } catch (err) {
      console.warn(`[crewbrief-posthog] alias failed:`, (err as Error).message);
    }
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
