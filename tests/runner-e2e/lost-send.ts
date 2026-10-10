import type { Page, Route } from "@playwright/test";

export interface CommittedChatSend {
  path: string;
  data: Record<string, unknown>;
  commentId: string;
}

/** Lose one real server acknowledgement, without keeping an expired browser request open. */
export async function dropChatSendAcknowledgement(page: Page, marker: string) {
  let resolve!: (value: CommittedChatSend) => void;
  let reject!: (error: unknown) => void;
  const committed = new Promise<CommittedChatSend>((yes, no) => { resolve = yes; reject = no; });
  // The route can fail before the caller finishes clicking Send. The caller
  // still observes the original rejection when it awaits committed.
  void committed.catch(() => undefined);
  let claimed = false;
  const pattern = "**/api/issues/*/comments";
  const handler = async (route: Route) => {
    if (route.request().method() !== "POST" || claimed) return route.continue();
    const data = route.request().postDataJSON() as Record<string, unknown>;
    if (typeof data.body !== "string" || !data.body.includes(marker)) return route.continue();
    claimed = true;
    try {
      const response = await route.fetch();
      if (!response.ok()) throw new Error(`Intercepted chat send returned ${response.status()}`);
      const comment = await response.json() as { id?: unknown };
      if (typeof comment.id !== "string") throw new Error("Intercepted chat send has no committed comment ID");
      await route.abort("connectionreset");
      resolve({ path: new URL(route.request().url()).pathname, data, commentId: comment.id });
    } catch (error) {
      reject(error);
    }
  };
  await page.route(pattern, handler);
  return { committed, dispose: () => page.unroute(pattern, handler) };
}
