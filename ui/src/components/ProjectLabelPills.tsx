import type { IssueLabel } from "@paperclipai/shared";
import { LabelPills } from "./LabelPills";

export function ProjectLabelPills({
  labels,
  variant = "full",
  className,
}: {
  labels?: IssueLabel[] | null;
  variant?: "dense" | "full";
  className?: string;
}) {
  return (
    <LabelPills
      labels={labels}
      maxVisible={variant === "dense" ? 1 : 3}
      preferredFirstName="Codex"
      className={className}
    />
  );
}
