import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";
import type { EndpointRow } from "../runtime-types.js";
import { logger } from "../../../middleware/logger.js";
import { retryableGitHubWebhookResponse } from "./webhook-authentication.js";

export async function initializeGitHubWebhookRuntime(
  endpoint: EndpointRow,
  runtimePromise: Promise<ChatEndpointRuntime>,
  githubResponseDeadlineAt: number | null,
  redactError: (error: unknown) => string,
): Promise<{ response: Response; runtime?: never } | { response?: never; runtime: ChatEndpointRuntime }> {
    let endpointRuntime: ChatEndpointRuntime;
    if (githubResponseDeadlineAt !== null) {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const outcome = await Promise.race([
          runtimePromise.then((value) => ({ completed: true as const, value })),
          new Promise<{ completed: false; value?: never }>((resolve) => {
            timeout = setTimeout(
              () => resolve({ completed: false }),
              Math.max(0, githubResponseDeadlineAt - Date.now()),
            );
            timeout.unref?.();
          }),
        ]);
        if (!outcome.completed) {
          return { response: retryableGitHubWebhookResponse(), runtime: undefined };
        }
        endpointRuntime = outcome.value;
      } catch (error) {
        logger.warn(
          { endpointId: endpoint.id, error: redactError(error) },
          "GitHub runtime initialization failed before durable webhook receipt",
        );
        return { response: retryableGitHubWebhookResponse(), runtime: undefined };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } else {
      endpointRuntime = await runtimePromise;
    }
  return { runtime: endpointRuntime };
}
