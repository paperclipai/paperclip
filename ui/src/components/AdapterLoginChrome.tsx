import { useEffect, useRef, useState, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";

import { Button } from "./ui/button";
import { copyTextToClipboard } from "../lib/clipboard";

/**
 * Which shell a login panel draws itself in.
 *
 * `panel` is the settings-side chrome the login panels have always had: a
 * titled card with its own "Sign in" button, sitting under an environment test
 * in the agent configuration form. It stays the default, because two surfaces
 * (the agent form and the new-agent page) render the panel that way and neither
 * is being redesigned here.
 *
 * `onboarding` is the connect step's card. The difference is not skin-deep: the
 * step's own footer button starts the login, so the panel has no "Sign in"
 * control of its own, and success is not something the card reports — the step
 * moves on. What is left is the part the customer acts on, which is the
 * instruction, the link, and the code.
 */
export type AdapterLoginChrome = "panel" | "onboarding";

/**
 * The connect step's login card: an instruction with a Cancel beside it, then
 * the rows the customer works through.
 *
 * The rows are the caller's, because the two login modes genuinely differ in
 * the last one — Claude takes a code back, OpenAI hands one out — while
 * everything above it is the same card. Passing children rather than a variant
 * flag keeps that difference where it actually lives.
 */
export function OnboardingLoginCard({
  instruction,
  onCancel,
  children,
}: {
  instruction: string;
  onCancel?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl bg-muted/40 px-4 py-3.5 flex flex-col gap-4">
      {/* No `gap`: `justify-between` already holds the two apart, and the eight
          pixels a gap reserves are eight the instruction does not have. The
          longest of these strings needs the full width between the inset and
          Cancel to stay on one line, which is how the design draws it — a gap
          here wrapped it onto a second.

          It is still allowed to wrap rather than being pinned to one line: a
          translation longer than the English will not fit however the row is
          divided, and two lines is a better failure than an overflow. */}
      {/* The instruction is a step down from Cancel, which is the hierarchy the
          design draws — the label describes, the button acts.

          It is also what keeps the longest of these strings on one line. The
          frame's own label measures 281px, and this string at 12px Inter
          measures 280px, where at 14px it needs 327px in a row that has 327px
          to give and wraps on the rounding. Matching the width the design
          actually renders is the closer reading of it than matching a nominal
          size in a font it was not drawn in. */}
      <div className="flex items-center justify-between pl-2">
        <span className="text-xs text-muted-foreground">{instruction}</span>
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2.5 text-sm font-medium"
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * One row inside the card: a 44px surface a shade lighter than the card itself.
 *
 * The lift is what makes the rows read as things to act on rather than lines of
 * the paragraph above them, and it is the same step the step's own name field
 * uses, so the two screens agree about what an input looks like.
 */
function LoginCardRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-(--sz-44px) items-center gap-2 rounded-lg bg-muted pl-5 pr-2.5">
      {children}
    </div>
  );
}

/**
 * The copy control at the right edge of a row.
 *
 * It swaps to a check for a moment after a copy, which is the only feedback a
 * clipboard write can honestly give — the write either happened or it did not,
 * and there is nothing to show for it on screen otherwise. `onCopied` lets a
 * row that wants a word as well as a mark hear about it.
 */
function LoginCardCopyButton({
  value,
  label,
  onCopied,
}: {
  value: string;
  label: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      className="size-6 shrink-0 text-muted-foreground hover:text-foreground [&_svg]:size-4"
      onClick={async () => {
        try {
          await copyTextToClipboard(value);
          setCopied(true);
          onCopied?.();
        } catch {
          setCopied(false);
        }
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

/**
 * The authentication link.
 *
 * Underlined and an actual anchor, because the instruction above it says to
 * open it — the copy button beside it is for the case where the login is being
 * finished in another browser, not the primary path. It truncates rather than
 * wrapping: these URLs carry a query string long enough to push the row to
 * three lines, and none of that tail tells the reader anything.
 */
export function OnboardingLoginUrlRow({ url }: { url: string }) {
  return (
    <LoginCardRow>
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="min-w-0 flex-1 truncate font-mono text-xs text-foreground underline underline-offset-4"
      >
        {url}
      </a>
      <LoginCardCopyButton value={url} label="Copy the authentication link" />
    </LoginCardRow>
  );
}

/**
 * The one-time code, for the login that hands one out.
 *
 * The word beside the button rather than only the mark on it: this code is
 * carried to another device, so the confirmation has to survive being read from
 * a step away.
 */
export function OnboardingLoginCodeRow({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  return (
    <LoginCardRow>
      <span className="min-w-0 flex-1 truncate font-mono text-sm tracking-wide text-foreground">
        {code}
      </span>
      {copied && <span className="shrink-0 text-xs text-muted-foreground">copied!</span>}
      <LoginCardCopyButton
        value={code}
        label="Copy the code"
        onCopied={() => {
          setCopied(true);
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          timeoutRef.current = setTimeout(() => setCopied(false), 1500);
        }}
      />
    </LoginCardRow>
  );
}

/**
 * The field the browser code is pasted back into.
 *
 * No Submit button beside it: the code arrives in one piece, off the clipboard,
 * so the paste is the answer and a press after it confirms nothing the paste
 * did not already say.
 *
 * `onPaste` is what the caller submits on, and it is separate from `onChange`
 * on purpose. There is no shape that says "this code is complete" —
 * `isValidBrowserCode` accepts any run of printable ASCII from one character up,
 * deliberately, because the provider's exact format is not pinned down — so a
 * submit driven by the value alone fires on the first keystroke of anyone who
 * types instead of pasting. Enter stays for them.
 */
export function OnboardingLoginCodeInput({
  value,
  onChange,
  onSubmit,
  onPaste,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onPaste?: () => void;
  disabled?: boolean;
}) {
  return (
    <input
      aria-label="Authorization code"
      type="text"
      autoComplete="off"
      spellCheck={false}
      placeholder="Paste authorization code here"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onPaste={() => onPaste?.()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit();
        }
      }}
      className="h-(--sz-44px) w-full rounded-lg bg-muted px-5 font-mono text-xs text-foreground placeholder:font-sans placeholder:text-sm placeholder:text-muted-foreground outline-none focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)"
    />
  );
}
