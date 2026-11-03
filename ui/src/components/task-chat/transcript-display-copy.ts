import { t } from "@/i18n";
import type { TaskChatUsageItem } from "./task-chat-model";

/** Resolve trusted local copy on render, including cached usage items. */
export function taskChatUsageDetail(item: TaskChatUsageItem): string | undefined {
  const keys = {
    providerSessionUsage: "oct26Transcript.providerSessionUsage",
    cumulativeSessionUsage: "oct26Transcript.cumulativeSessionUsage",
  } as const;
  return item.detailMessage ? t(keys[item.detailMessage]) : item.detail;
}
