import { cn } from "../lib/utils";

export function QodoLogoIcon({ className }: { className?: string }) {
  return (
    <svg fill="currentColor" viewBox="0 0 24 24" className={cn(className)} xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2a8 8 0 00-8 8v4a8 8 0 0013.06 6.19l2.65 2.65a1.25 1.25 0 001.77-1.77l-2.42-2.42A8 8 0 0020 14v-4a8 8 0 00-8-8zm0 2.5A5.5 5.5 0 0117.5 10v4A5.5 5.5 0 1112 4.5z" />
    </svg>
  );
}
