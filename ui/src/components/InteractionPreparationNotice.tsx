import { t, useTranslation } from "@/i18n";
import { Loader2 } from "lucide-react";

export function InteractionPreparationNotice() {
  useTranslation("task-components");
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 aria-hidden className="h-4 w-4 animate-spin" />{t("task-components:preparingApproval_3f797b41")}</div>
  );
}
