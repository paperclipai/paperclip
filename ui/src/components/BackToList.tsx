import { ArrowLeft } from "lucide-react";
import { Link } from "@/lib/router";

interface BackToListProps {
  to: string;
  label: string;
}

/**
 * Subtle "back to list" link for detail pages.
 * Renders a small left-arrow + label at the top-left.
 */
export function BackToList({ to, label }: BackToListProps) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors -ml-0.5 mb-2"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      {label}
    </Link>
  );
}
