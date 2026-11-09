import type { VoiceTranscriptEntry } from "@/lib/voice-transcript";
import { useTranslation } from "@/i18n";

export interface VoiceTranscriptProps {
  entries: readonly VoiceTranscriptEntry[];
  agentName: string;
  unavailable?: boolean;
}

/** Announcements belong to the session controller, once per final segment. */
export function VoiceTranscript({ entries, agentName, unavailable = false }: VoiceTranscriptProps) {
  const { t } = useTranslation();
  if (unavailable) return <p className="text-sm text-muted-foreground">{t("agents.VoiceTranscript.unavailable")}</p>;
  if (!entries.length) return <p className="text-sm text-muted-foreground">{t("agents.VoiceTranscript.empty")}</p>;
  return (
    <ol aria-label={t("agents.VoiceTranscript.label")} aria-live="off" className="flex min-w-0 flex-col gap-4">
      {entries.map((entry) => (
        <li key={entry.id} className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground break-words">
            {entry.source === "user" ? t("agents.VoiceTranscript.you") : entry.source === "application" ? "Paperclip" : agentName}
            {!entry.final && !entry.interrupted && <span> · {t("agents.VoiceTranscript.speaking")}</span>}
            {entry.interrupted && <span> · {t("agents.VoiceTranscript.interrupted")}</span>}
          </span>
          <p className="whitespace-pre-wrap break-words text-sm">{entry.text}</p>
        </li>
      ))}
    </ol>
  );
}
