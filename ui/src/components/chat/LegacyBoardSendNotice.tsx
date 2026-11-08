import { t, useTranslation } from "@/i18n";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export function LegacyBoardSendNotice({ onDiscard }: { onDiscard: () => void }) {
  useTranslation("task-components");
  return <AlertDialog>
    <AlertDialogTrigger asChild>
      <Button size="sm" variant="outline">{t("task-components:sentence_d4e26c37b155")}</Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{t("task-components:sentence_d41005ee300e")}</AlertDialogTitle>
        <AlertDialogDescription>{t("task-components:sentence_a333dfb11899")}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{t("task-components:sentence_562a1cd235fc")}</AlertDialogCancel>
        <AlertDialogAction onClick={onDiscard}>{t("task-components:sentence_de3035c741cb")}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
