import { useTranslation } from "@/i18n";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export function LegacyBoardSendNotice({ onDiscard }: { onDiscard: () => void }) {
  const { t } = useTranslation();
  return <AlertDialog>
    <AlertDialogTrigger asChild>
      <Button size="sm" variant="outline">{t("chat.legacySend.discardRecord", "Discard saved delivery record")}</Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{t("chat.legacySend.discardTitle", "Discard saved delivery record?")}</AlertDialogTitle>
        <AlertDialogDescription>
          {t("chat.legacySend.discardDescription", "First check Activity. Discarding this browser record does not cancel an update that was already accepted. It lets you start a new update.")}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{t("chat.legacySend.keepRecord", "Keep record")}</AlertDialogCancel>
        <AlertDialogAction onClick={onDiscard}>{t("chat.legacySend.confirmDiscard", "Discard record")}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
