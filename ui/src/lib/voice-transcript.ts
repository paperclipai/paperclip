/** One entry per transport segment. Never merge distinct turns by speaker. */
export interface VoiceTranscriptEntry {
  id: string;
  source: "user" | "agent" | "application";
  text: string;
  final: boolean;
  interrupted?: boolean;
}
export interface VoiceTranscriptUpdate {
  segmentId?: string;
  source: "user" | "agent";
  text: string;
  isFinal: boolean;
}
export function updateVoiceTranscript(
  entries: readonly VoiceTranscriptEntry[],
  update: VoiceTranscriptUpdate,
  fallbackId: string,
): VoiceTranscriptEntry[] {
  if (!update.text.trim()) return [...entries];
  const id = `${update.source}:${update.segmentId ?? fallbackId}`;
  const index = entries.findIndex((entry) => entry.id === id);
  const previous = entries[index];
  // A late recognizer partial must not replace a committed final transcript.
  if (previous?.final && !update.isFinal) return [...entries];
  const next = { id, source: update.source, text: update.text, final: update.isFinal, ...(previous?.interrupted ? { interrupted: true } : {}) };
  if (index < 0) return [...entries, next];
  return entries.map((entry, i) => i === index ? next : entry);
}
