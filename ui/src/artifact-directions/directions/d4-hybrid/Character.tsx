import { useState } from "react";
import { cn } from "@/lib/utils";
import { AVATARS } from "../../fixtures";

/**
 * THE AGENT CHARACTER — the agent's drawn avatar in a panel card's footer
 * (screen 10): the same stand-in the thread puts beside an agent's message,
 * so a card says who made the thing the way the thread says who is speaking.
 *
 * The box is 32px, the height of the two-line byline beside it; the drawing
 * stands about 28px tall in it, as the mock's character does beside its own
 * byline (screen 10 draws it at the byline's height, a little under the Open
 * button's). An agent the fixtures have no drawing for — or whose drawing
 * fails to load — gets its initials on the neutral button fill, never a kind
 * hue and never a broken-image glyph, so the footer's lockup holds for every
 * author.
 */
export function Character({ name, className }: { name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = AVATARS[name];
  // "Brand and Presentation Designer" → BP: the capitalised words, two at most.
  const initials = name
    .split(/\s+/)
    .filter((word) => /^[A-Z]/.test(word))
    .slice(0, 2)
    .map((word) => word[0])
    .join("");
  return (
    <span data-character className={cn("relative inline-flex size-8 shrink-0 items-center justify-center", className)}>
      {src && !failed ? (
        <img src={src} alt="" width={32} height={32} onError={() => setFailed(true)} className="size-full object-contain" />
      ) : (
        <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-(--hy-button) font-sans text-(length:--text-micro) font-semibold leading-none text-foreground">
          {initials}
        </span>
      )}
    </span>
  );
}
