import { t, useTranslation } from "@/i18n";
import type { VoiceTranscriptEntry } from "@/lib/voice-transcript";

export interface VoiceTranscriptProps {
  entries: readonly VoiceTranscriptEntry[];
  agentName: string;
  unavailable?: boolean;
}

/** Announcements belong to the session controller, once per final segment. */
export function VoiceTranscript({ entries, agentName, unavailable = false }: VoiceTranscriptProps) {
  useTranslation();
  if (unavailable) return <p className="text-sm text-muted-foreground">{t("oct19Voice.theTranscriptIsUnavailableYourTask_1u628mf")}</p>;
  if (!entries.length) return <p className="text-sm text-muted-foreground">{t("oct19Voice.yourConversationWillAppearHere_1novskw")}</p>;
  return (
    <ol aria-label={t("oct19Voice.conversationTranscript_1ss354w")} aria-live="off" className="flex min-w-0 flex-col gap-4">
      {entries.map((entry) => (
        <li key={entry.id} className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground break-words">
            {entry.source === "user" ? t("oct19Voice.you_1efd4xo") : entry.source === "application" ? "Paperclip" : agentName}
            {!entry.final && !entry.interrupted && <span>{t("oct19Voice.speaking_1ww9qkq")}</span>}
            {entry.interrupted && <span>{t("oct19Voice.interrupted_1vxezsa")}</span>}
          </span>
          <p className="whitespace-pre-wrap break-words text-sm">{entry.generated === "task_update" ? t("oct19Voice.aTaskUpdateIsAvailable_4w9mvl") : entry.text}</p>
        </li>
      ))}
    </ol>
  );
}
