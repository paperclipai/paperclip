import { isExternalChatWaitAuthorizationContention } from "./native-runtime/chat-attachment-reuse.js";

/** Retry only a rolled-back admission transaction, never provider execution. */
export async function retryChatControlAdmission<T>(attempt: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (retry >= 50 || !isExternalChatWaitAuthorizationContention(error)) throw error;
    }
    // The previous transaction has released all locks. The next attempt must
    // read current run ownership and close evidence again before admission.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
