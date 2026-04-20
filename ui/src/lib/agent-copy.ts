import type { ToastInput } from "../context/ToastContext";
import { copyTextToClipboard } from "./clipboard";

type PushToast = (input: ToastInput) => string | null;

export async function copyAgentId(agentId: string, pushToast: PushToast): Promise<boolean> {
  const copied = await copyTextToClipboard(agentId);

  pushToast(
    copied
      ? {
          title: "Agent ID copied",
          tone: "success",
        }
      : {
          title: "Copy failed",
          body: "Clipboard access was blocked. Try again from a secure browser context.",
          tone: "error",
        },
  );

  return copied;
}
