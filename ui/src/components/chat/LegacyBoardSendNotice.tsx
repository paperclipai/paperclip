import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export function LegacyBoardSendNotice({ onDiscard }: { onDiscard: () => void }) {
  return <AlertDialog>
    <AlertDialogTrigger asChild>
      <Button size="sm" variant="outline">Discard saved delivery record</Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Discard saved delivery record?</AlertDialogTitle>
        <AlertDialogDescription>
          First check Activity. Discarding this browser record does not cancel an update
          that was already accepted. It lets you start a new update.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Keep record</AlertDialogCancel>
        <AlertDialogAction onClick={onDiscard}>Discard record</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
