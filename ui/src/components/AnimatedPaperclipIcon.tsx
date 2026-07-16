import type { SVGProps } from "react";
import { cn } from "../lib/utils";

export function AnimatedPaperclipIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="-1 -1 26 26"
      className={cn("paperclip-thinking-icon", className)}
      aria-hidden="true"
      {...props}
    >
      <path
        className="paperclip-thinking-icon-path"
        d="M16 6 l-8.414 8.586 a2.000 2.000 0 0 0 2.828 2.828 l8.414 -8.586 a4.000 4.000 0 1 0 -5.657 -5.657 l-8.379 8.551 a6.000 6.000 0 1 0 8.485 8.485 l8.379 -8.551"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
