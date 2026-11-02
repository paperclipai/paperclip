import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

export function LegacyBoardSendNotice({ onDiscard }: { onDiscard: () => void }) {
  const { t } = useTranslation();
  return <AlertDialog>
    <AlertDialogTrigger asChild>
      <Button size="sm" variant="outline">{t("nov02Core.delivery.discardSaved")}</Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{t("nov02Core.delivery.discardQuestion")}</AlertDialogTitle>
        <AlertDialogDescription>
          {t("nov02Core.delivery.description")}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{t("nov02Core.delivery.keep")}</AlertDialogCancel>
        <AlertDialogAction onClick={onDiscard}>{t("nov02Core.delivery.discard")}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
