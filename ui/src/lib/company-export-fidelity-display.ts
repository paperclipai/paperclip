import type { PortabilityFidelityWarning } from "@paperclipai/shared/portability-fidelity";
import { t } from "@/i18n";

const KNOWN_WARNINGS = {
  cost_history_not_exported: {
    singular: "cost event",
    plural: "cost events",
    key: "localizationProjects.exportCostEventsOmitted",
  },
  activity_history_not_exported: {
    singular: "activity log entry",
    plural: "activity log entries",
    key: "localizationProjects.exportActivityEntriesOmitted",
  },
} as const;

/** Localize only the exact shared/portability-fidelity producer templates at render time. */
export function companyExportFidelityWarningDisplay(
  warning: Pick<PortabilityFidelityWarning, "code" | "message">,
): string {
  const { code, message } = warning;
  if (!Object.hasOwn(KNOWN_WARNINGS, code)) return message;
  const rule = KNOWN_WARNINGS[code as keyof typeof KNOWN_WARNINGS];
  const countMatch = /^([1-9]\d*) /.exec(message);
  if (!countMatch) return message;
  const count = Number(countMatch[1]);
  if (!Number.isSafeInteger(count)) return message;

  // This reconstructs the producer text only to recognize it, not to build UI copy.
  // Full equality also rejects trailing newlines, leading zeroes and changed diagnostics.
  const subject = count === 1 ? `${rule.singular} is` : `${rule.plural} are`;
  if (message !== `${count} ${subject} not included in the export bundle.`) return message;
  return t(rule.key, { count });
}
