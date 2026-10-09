import type { VoiceTranscriptEntry } from "@/lib/voice-transcript";

export interface VoiceTranscriptProps {
  entries: readonly VoiceTranscriptEntry[];
  agentName: string;
  unavailable?: boolean;
}

/** Announcements belong to the session controller, once per final segment. */
export function VoiceTranscript({ entries, agentName, unavailable = false }: VoiceTranscriptProps) {
  if (unavailable) return <p className="text-sm text-muted-foreground">The transcript is unavailable. Your task history is still available.</p>;
  if (!entries.length) return <p className="text-sm text-muted-foreground">Your conversation will appear here.</p>;
  return (
    <ol aria-label="Conversation transcript" aria-live="off" className="flex min-w-0 flex-col gap-4">
      {entries.map((entry) => (
        <li key={entry.id} className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground break-words">
            {entry.source === "user" ? "You" : entry.source === "application" ? "Paperclip" : agentName}
            {!entry.final && <span> · Speaking</span>}
            {entry.interrupted && <span> · Interrupted</span>}
          </span>
          <p className="whitespace-pre-wrap break-words text-sm">{entry.text}</p>
        </li>
      ))}
    </ol>
  );
}
