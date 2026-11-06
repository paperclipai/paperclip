import { Check, Copy, X } from "lucide-react";
import { useCopyAction } from "@/lib/use-copy-action";
import { Button } from "./ui/button";

/**
 * The reviewed-arguments hash identifies exactly what an approval covers, which
 * matters for audits but means nothing to the person approving. Keep it off the
 * card and reachable through a copy action instead of printing the raw digest.
 */
export function ToolActionAuditHashCopy({ hash }: { hash: string }) {
  const { status, copy } = useCopyAction();
  const label = status === "copied" ? "Copied" : status === "failed" ? "Couldn’t copy" : "Copy audit hash";
  const Icon = status === "copied" ? Check : status === "failed" ? X : Copy;
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="mt-1 text-muted-foreground"
      title="Copy the hash that identifies these exact arguments"
      onClick={() => void copy(hash)}
    >
      <Icon aria-hidden="true" />
      {label}
    </Button>
  );
}
