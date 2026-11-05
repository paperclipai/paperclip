import { useTranslation } from "@/i18n";
import type { VoiceTranscriptEntry } from "@/lib/voice-transcript";

export interface VoiceTranscriptProps {
  entries: readonly VoiceTranscriptEntry[];
  agentName: string;
  unavailable?: boolean;
}

/** Announcements belong to the session controller, once per final segment. */
export function VoiceTranscript({ entries, agentName, unavailable = false }: VoiceTranscriptProps) {
  const { t } = useTranslation("connections");
  if (unavailable) return <p className="text-sm text-muted-foreground">{t("the_transcript_is_unavailable_your_task_history_49108be")}</p>;
  if (!entries.length) return <p className="text-sm text-muted-foreground">{t("your_conversation_will_appear_here_06a663e")}</p>;
  return (
    <ol aria-label={t("conversation_transcript_1682dd6")} aria-live="off" className="flex min-w-0 flex-col gap-4">
      {entries.map((entry) => (
        <li key={entry.id} className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground break-words">
            {entry.source === "user" ? t("you_905cb32") : entry.source === "application" ? "Paperclip" : agentName}
            {!entry.final && !entry.interrupted && <span>{t("speaking_18da819")}</span>}
            {entry.interrupted && <span>{t("interrupted_98a88de")}</span>}
          </span>
          <p className="whitespace-pre-wrap break-words text-sm">{entry.text}</p>
        </li>
      ))}
    </ol>
  );
}
