import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Copy, Check, Loader2 } from "lucide-react";

import { Button } from "./ui/button";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  CARD_REVEAL_FIELD,
  CARD_REVEAL_INSTRUCTION,
  CARD_REVEAL_TRAVEL,
  COPIED_REVEAL,
  COPIED_REVEAL_DELAY_MS,
  COPIED_REVEAL_TRAVEL,
} from "./onboarding/onboarding-motion";

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
 * What the connect step calls each source.
 *
 * One map, read by the tile row and by the sign-in card's sentence, so the row
 * and the card cannot end up calling the same provider different things.
 *
 * Deliberately not the display registry's label, which ten other surfaces read
 * and which names the tool that runs ("Codex CLI was not found on this host").
 * Also not `ADAPTER_LOGIN_PROVIDER`, which names the account being signed in to
 * — "Anthropic" is right in a settings panel listing credentials and wrong in a
 * sentence that reads "Sign in to Claude".
 *
 * Three names for two adapters is a tension worth stating rather than hiding.
 * The concepts differ — vendor, tool, account — but if the product decides
 * otherwise, this is the one to delete.
 */
export const CONNECT_SOURCE_NAMES: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "OpenAI",
};

/** The provider name for a source, falling back to the type when unlisted. */
export function connectSourceName(adapterType: string): string {
  return CONNECT_SOURCE_NAMES[adapterType] ?? adapterType;
}

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
  loading = false,
  children,
}: {
  /**
   * A node rather than a string: the sign-in cards pass a sentence, and the
   * key card passes the environment variable it will write to, which has to
   * be mono to read as a name rather than as prose.
   */
  instruction: ReactNode;
  onCancel?: () => void;
  /**
   * Show a spinner instead of the contents, at the same height.
   *
   * The card opens before the sign-in has anything to put in it. Rendering it
   * empty and growing later would push the footer twice for one event, so both
   * states share a floor — see `--sz-108px`, which is exactly the height of an
   * instruction over one row. A card holding more than that (the settings
   * chrome's link *and* field) still grows past it.
   */
  loading?: boolean;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div
        className="flex min-h-(--sz-108px) items-center justify-center rounded-xl bg-muted/40"
        role="status"
        aria-label="Preparing the sign-in"
      >
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-(--sz-108px) flex-col gap-4 rounded-xl bg-muted/40 p-4">
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
      <motion.div
        className="flex items-center justify-between pl-2"
        initial={{ opacity: 0, y: CARD_REVEAL_TRAVEL }}
        animate={{ opacity: 1, y: 0, transition: CARD_REVEAL_INSTRUCTION }}
      >
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
      </motion.div>
      {/* A beat behind the sentence above it, so the card reads as one thing
          unfolding and the instruction has been read by the time the field is
          ready to be pasted into. */}
      <motion.div
        initial={{ opacity: 0, y: CARD_REVEAL_TRAVEL }}
        animate={{ opacity: 1, y: 0, transition: CARD_REVEAL_FIELD }}
      >
        {children}
      </motion.div>
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
      className="size-6 shrink-0 text-muted-foreground hover:text-foreground [&_svg]:size-3"
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
 * The one-time code, for the login that hands one out.
 *
 * `autoCopy` puts it on the clipboard as the card lands and says so. The code
 * is going to be pasted somewhere else — that is its whole purpose — so making
 * the customer press a button first is a step that exists only to be completed.
 *
 * The claim is made only when the write actually succeeded. A clipboard write
 * needs transient user activation, and this one happens a beat after the press
 * that started the sign-in, so a browser may well refuse it; "Copied!" over an
 * empty clipboard would send someone to paste nothing. The button beside it is
 * the path that always works, and is why the failure is quiet rather than an
 * error.
 */
export function OnboardingLoginCodeRow({
  code,
  autoCopy = false,
}: {
  code: string;
  autoCopy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoCopiedRef = useRef(false);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  useEffect(() => {
    if (!autoCopy || autoCopiedRef.current) return;
    autoCopiedRef.current = true;
    void copyTextToClipboard(code)
      .then(() => {
        // Written now, said later: the clipboard should be ready the instant
        // the code is readable, but the claim waits for the rest of the card to
        // stop moving — see COPIED_REVEAL_DELAY_MS.
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(true), COPIED_REVEAL_DELAY_MS);
      })
      .catch(() => {
        // Refused, most likely for want of user activation. The button stays.
      });
  }, [autoCopy, code]);

  return (
    <div className="flex h-(--sz-44px) items-center gap-2 rounded-lg bg-muted px-4">
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{code}</span>
      <AnimatePresence initial={false}>
        {copied && (
          <motion.span
            key="copied"
            className="shrink-0 text-sm text-muted-foreground/40"
            initial={{ opacity: 0, y: COPIED_REVEAL_TRAVEL }}
            animate={{ opacity: 1, y: 0, transition: COPIED_REVEAL }}
            exit={{ opacity: 0, transition: COPIED_REVEAL }}
          >
            Copied!
          </motion.span>
        )}
      </AnimatePresence>
      <LoginCardCopyButton
        value={code}
        label="Copy the code"
        onCopied={() => {
          // No wait here. A press is a direct action, and delaying its
          // acknowledgement would read as the button having missed.
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          setCopied(true);
        }}
      />
    </div>
  );
}

/**
 * One row's worth of input, shared by every card that takes one.
 *
 * Exported rather than duplicated because the two inputs that use it — the
 * browser code here and the API key on the credential card — sit in the same
 * canvas one toggle apart, so a divergence between them is visible by flipping
 * a switch. They differ in what they hold, not in what they look like.
 */
export const onboardingCardInputClass =
  "h-(--sz-44px) w-full rounded-lg bg-muted px-5 font-mono text-xs text-foreground " +
  "placeholder:font-sans placeholder:text-sm placeholder:text-muted-foreground " +
  "outline-none focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)";

/**
 * The card's single-line field, whatever the card is asking for.
 *
 * Three cards use it and they want different things: a browser code pasted
 * back, and an API key typed or pasted in. Same row, same measurements — what
 * changes is the label, the placeholder, and whether the value should be masked.
 *
 * No Submit button beside it in the code case: the code arrives in one piece,
 * off the clipboard, so the paste is the answer and a press after it confirms
 * nothing the paste did not already say.
 *
 * `onPaste` is what that case submits on, and it is separate from `onChange` on
 * purpose. There is no shape that says "this code is complete" —
 * `isValidBrowserCode` accepts any run of printable ASCII from one character
 * up, deliberately, because the provider's exact format is not pinned down — so
 * a submit driven by the value alone fires on the first keystroke of anyone who
 * types instead of pasting. Enter stays for them. A key field simply omits it:
 * a key is not submitted by arriving, it is submitted by the step's own button.
 */
export function OnboardingCardField({
  value,
  onChange,
  onSubmit,
  onPaste,
  disabled,
  label = "Authorization code",
  placeholder = "Paste authorization code here",
  masked = false,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onPaste?: () => void;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  /** A provider key is a credential; a one-time browser code is not. */
  masked?: boolean;
  /**
   * Take focus when the card opens.
   *
   * For the key card, where the field is the only thing being asked for and the
   * card only opens because it was asked for. The code cards do not: their
   * customer is on their way to another tab, and a caret waiting behind them is
   * not where the next action is.
   */
  autoFocus?: boolean;
}) {
  return (
    <input
      // eslint-disable-next-line jsx-a11y/no-autofocus -- see the prop's note
      autoFocus={autoFocus}
      aria-label={label}
      type={masked ? "password" : "text"}
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
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
      className={onboardingCardInputClass}
    />
  );
}
