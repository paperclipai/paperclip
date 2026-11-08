import { t } from "@/i18n";
import type { AgentInstructionsFileSummary } from "@paperclipai/shared";
import { formatDate } from "@/lib/utils";

/** Missing historical metadata must never become an invented creation date. */
export function instructionFileDateLabel(file?: Pick<AgentInstructionsFileSummary, "createdAt" | "updatedAt"> | null) {
  if (file?.updatedAt && Number.isFinite(Date.parse(file.updatedAt))) return t("agents:instruction_file_last_updated", { value1: formatDate(file.updatedAt) });
  if (file?.createdAt && Number.isFinite(Date.parse(file.createdAt))) return t("agents:instruction_file_date_created", { value1: formatDate(file.createdAt) });
  return t("agents:instruction_file_date_unavailable");
}
