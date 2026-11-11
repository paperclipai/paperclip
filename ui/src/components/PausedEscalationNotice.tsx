import { AlertTriangle } from "lucide-react";

import { pausedEscalationCopy } from "@/i18n/paused-escalation";
import { useUiLanguage } from "@/i18n/tx";

export function PausedEscalationNotice({
  agentName,
  pausedAncestorName,
  english,
}: {
  agentName: string;
  pausedAncestorName?: string | null;
  english: string;
}) {
  const language = useUiLanguage();
  const copy = pausedEscalationCopy(language, english, agentName, pausedAncestorName);
  return (
    <div className="flex items-start gap-3 border border-amber-300/35 bg-amber-300/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{copy.title}</p>
        <p className="text-amber-900/90 dark:text-amber-100/90">{copy.body}</p>
      </div>
    </div>
  );
}
