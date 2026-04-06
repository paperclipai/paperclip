import { cn } from "../lib/utils";

interface OmcLogoProps {
  className?: string;
}

/**
 * OH MY COMPANY logo icon — stylized dragon/claw mark rendered as pure SVG.
 * Uses `currentColor` so it inherits the text color (works in light & dark themes).
 */
export function OmcLogo({ className }: OmcLogoProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-label="OH MY COMPANY"
    >
      {/* Outer circular sweep / dragon body */}
      <path
        d="M32 4C16.536 4 4 16.536 4 32c0 10.83 6.15 20.22 15.15 24.9l1.85-3.2C13.2 49.8 8 41.45 8 32 8 18.745 18.745 8 32 8c8.28 0 15.6 4.2 19.92 10.58l3.28-1.88C50.56 9.36 41.84 4 32 4Z"
        fill="currentColor"
      />
      {/* Inner claw / talon upper */}
      <path
        d="M48 20c-2.4-2.8-6.2-5.6-11-6.4-6.2-1-11.8 1.6-15.2 5.8-3.8 4.6-4.6 10.8-2.2 16.4 1.4 3.2 3.8 5.8 6.8 7.6l6-10.4c1.2-2 3.6-2.8 5.6-1.6 2 1.2 2.8 3.6 1.6 5.6l-6 10.4c3.4.4 7-.4 10-2.4 5.2-3.4 7.8-9.6 7-15.8-.4-3.4-1.6-6.4-2.6-9.2Z"
        fill="currentColor"
      />
      {/* Claw tips / accent strokes */}
      <path
        d="M22 50.4c1.6 1 3.4 1.6 5.2 2l2.4-4.2c-1.8-.2-3.6-.8-5.2-1.8l-2.4 4Z"
        fill="currentColor"
      />
      <path
        d="M45.6 16.4c1.2 1.6 2.2 3.4 2.8 5.4l4-2.3c-.8-2-2-3.8-3.4-5.4l-3.4 2.3Z"
        fill="currentColor"
      />
    </svg>
  );
}
