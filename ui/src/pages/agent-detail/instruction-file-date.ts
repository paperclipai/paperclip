import type { AgentInstructionsFileSummary } from "@paperclipai/shared";
import { formatDate } from "@/lib/utils";

/** Missing historical metadata must never become an invented creation date. */
export function instructionFileDateLabel(file?: Pick<AgentInstructionsFileSummary, "createdAt" | "updatedAt"> | null) {
  if (file?.updatedAt && Number.isFinite(Date.parse(file.updatedAt))) return `Last updated ${formatDate(file.updatedAt)}`;
  if (file?.createdAt && Number.isFinite(Date.parse(file.createdAt))) return `Date created ${formatDate(file.createdAt)}`;
  return "Date unavailable";
}
