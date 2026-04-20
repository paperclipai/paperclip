import type { SessionEventPayload } from "@github/copilot-sdk";
import type { CopilotSessionLike } from "./sdk-client.js";

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function isCopilotIdleTimeoutError(error: unknown): boolean {
  const message = toError(error).message;
  return /Timeout after \d+ms waiting for session\.idle/i.test(message);
}

export async function sendPromptAndWaitForIdle(
  session: CopilotSessionLike,
  prompt: string,
  timeoutMs: number | null,
): Promise<SessionEventPayload<"assistant.message"> | undefined> {
  let resolveIdle = () => {};
  let rejectIdle = (_error: Error) => {};
  const idlePromise = new Promise<void>((resolve, reject) => {
    resolveIdle = resolve;
    rejectIdle = reject;
  });

  let lastAssistantMessage: SessionEventPayload<"assistant.message"> | undefined;
  const unsubscribe = session.on((event) => {
    if (event.type === "assistant.message") {
      lastAssistantMessage = event;
      return;
    }
    if (event.type === "session.idle") {
      resolveIdle();
      return;
    }
    if (event.type === "session.error") {
      const message =
        typeof event.data.message === "string" && event.data.message.trim().length > 0
          ? event.data.message.trim()
          : "Copilot session error";
      rejectIdle(new Error(message));
    }
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await session.send({ prompt });
    if (timeoutMs && timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timeout after ${timeoutMs}ms waiting for session.idle`));
        }, timeoutMs);
      });
      await Promise.race([idlePromise, timeoutPromise]);
    } else {
      await idlePromise;
    }
    return lastAssistantMessage;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    unsubscribe();
  }
}
