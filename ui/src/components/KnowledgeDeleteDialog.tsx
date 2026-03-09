import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { KnowledgeItem } from "@paperclipai/shared";
import { knowledgeApi } from "../api/knowledge";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function KnowledgeDeleteDialog({
  item,
  open,
  onOpenChange,
  onDeleted,
}: {
  item: KnowledgeItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (item: KnowledgeItem) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error("Knowledge item is required");
      await knowledgeApi.remove(item.id);
      return item;
    },
    onSuccess: async (deleted) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.list(deleted.companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.detail(deleted.id) }),
        queryClient.invalidateQueries({ queryKey: ["issues", "knowledge"] }),
      ]);
      pushToast({ title: "Knowledge item deleted", tone: "success" });
      onOpenChange(false);
      onDeleted?.(deleted);
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to delete knowledge item",
        tone: "error",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete knowledge item?</DialogTitle>
          <DialogDescription>
            {item
              ? `This removes "${item.title}" from the company library and detaches it from any issues using it.`
              : "This removes the selected knowledge item from the company library."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleteMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => deleteMutation.mutate()}
            disabled={!item || deleteMutation.isPending}
          >
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
