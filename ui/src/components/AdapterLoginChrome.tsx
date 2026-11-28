import { useEffect, useId, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
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
import { ANALYTICS_MASK_CLASS, ANALYTICS_NO_CAPTURE_CLASS } from "@/lib/analytics/privacy";
import { describeError } from "@/api/errors";
import { cn } from "@/lib/utils";

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
  grok_local: "Grok",
  antigravity_runtime: "Antigravity",
};

/** The provider name for a source, falling back to the type when unlisted. */
export function connectSourceName(adapterType: string): string {
  return CONNECT_SOURCE_NAMES[adapterType] ?? adapterType;
}

/**
 * The connect step's login card: an instruction, then the rows the customer
 * works through.
 *
 * The rows are the caller's, because the two login modes genuinely differ in
 * the last one — Claude takes a code back, OpenAI hands one out — while
 * everything above it is the same card. Passing children rather than a variant
 * flag keeps that difference where it actually lives.
 */
export function OnboardingLoginCard({
  instruction,
  loading = false,
  children,
}: {
  /**
   * A node rather than a string: the sign-in cards pass a sentence, and the
   * key card passes the environment variable it will write to, which has to
   * be mono to read as a name rather than as prose.
   */
  instruction: ReactNode;
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
      {/* The row is the instruction alone. It shared this line with a Cancel
          until that button went — it repeated the footer's Back, which is the
          step's one way out.

          12px, not 14. The frame's own label measures 281px and this string at
          12px Inter measures 280px, where at 14px it needs 327px in a row that
          has 327px to give and wraps on the rounding. Matching the width the
          design actually renders is the closer reading of it than matching a
          nominal size in a font it was not drawn in.

          Still allowed to wrap: a translation longer than the English will not
          fit however the row is divided, and two lines is a better failure
          than an overflow. */}
      <motion.div
        className="flex items-center pl-2"
        initial={{ opacity: 0, y: CARD_REVEAL_TRAVEL }}
        animate={{ opacity: 1, y: 0, transition: CARD_REVEAL_INSTRUCTION }}
      >
        <span className="text-xs text-muted-foreground">{instruction}</span>
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

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

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

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    // An empty code is not a code. The row renders before the server's one-time
    // prompt has a value on some paths, and the previous version latched on
    // that first run — so the copy that mattered never ran, and the card said
    // "Copied!" over an empty clipboard.
    if (!autoCopy || autoCopiedRef.current || !code) return;

    let cancelled = false;
    // The success latch is taken when the write resolves, so it cannot also
    // stand in for "a write is already running" — a focus event landing while
    // one was in flight started a second. Same text either way, but it doubles
    // the reveal timers and there is no reason to ask twice.
    let inFlight = false;

    const attempt = () => {
      if (cancelled || autoCopiedRef.current || inFlight) return;
      // A write from an unfocused document is refused, and worse, some engines
      // resolve it without writing. Wait for focus rather than spend the one
      // attempt on it.
      if (typeof document !== "undefined" && !document.hasFocus()) return;
      inFlight = true;
      void copyTextToClipboard(code)
        .then(() => {
          if (cancelled) return;
          // Latched on success, not before it. Latching up front made the first
          // refusal permanent — and the first attempt is the one most likely to
          // be refused, since it fires while the card is still arriving.
          autoCopiedRef.current = true;
          window.removeEventListener("focus", attempt);
          // Written now, said later: the clipboard should be ready the instant
          // the code is readable, but the claim waits for the rest of the card
          // to stop moving — see COPIED_REVEAL_DELAY_MS.
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          timeoutRef.current = setTimeout(
            () => setCopied(true),
            COPIED_REVEAL_DELAY_MS,
          );
        })
        .catch(() => {
          // Refused. The listener gives it another go when the document comes
          // back, and the button is there the whole time regardless.
        })
        .finally(() => {
          inFlight = false;
        });
    };

    attempt();
    window.addEventListener("focus", attempt);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", attempt);
    };
  }, [autoCopy, code]);

  return (
    <div className="flex h-(--sz-44px) items-center gap-2 rounded-lg bg-muted px-4">
      <span className={cn("min-w-0 flex-1 truncate text-sm text-foreground", ANALYTICS_NO_CAPTURE_CLASS)}>
        {code}
      </span>
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
  description,
  placeholder = "Paste authorization code here",
  masked = false,
  autoFocus = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  label?: string;
  description?: string;
  placeholder?: string;
  /**
   * Dots instead of the value. The key card asks for it because a provider key
   * is a credential that goes on living. The Claude card asks too: its code
   * stays in the field after the paste so the customer can see something
   * landed, and that is all they need to see of it.
   */
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
  className?: string;
}) {
  const descriptionId = useId();
  const input = (
    <input
      // eslint-disable-next-line jsx-a11y/no-autofocus -- see the prop's note
      autoFocus={autoFocus}
      aria-label={label}
      aria-describedby={description ? descriptionId : undefined}
      type={masked ? "password" : "text"}
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onPaste={onPaste}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit();
        }
      }}
      className={className ? cn(onboardingCardInputClass, className) : onboardingCardInputClass}
    />
  );
  if (!description) return input;

  return (
    <div className="flex flex-col gap-2">
      {input}
      <p id={descriptionId} className="px-5 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

/** Shared authentication presentation. Hosts retain their existing session lifecycle. */
export function ProviderSubscriptionCard({
  providerName,
  authorizationUrl,
  onOpenAuthorization,
  mode,
  loading,
  failure,
  failureMessage,
  onRetry,
  children,
}: {
  providerName: string;
  authorizationUrl?: string;
  onOpenAuthorization?: () => void;
  failure?: "expired" | "failed";
  failureMessage?: string;
  onRetry?: () => void;
  mode: "submitted_code" | "displayed_code" | "browser_redirect" | "hosted_redirect";
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <OnboardingLoginCard
      loading={loading}
      instruction={failure ? (failure === "expired" ? "This sign-in expired" : "Sign-in didn’t finish") : (
        <>
          <a
            href={authorizationUrl}
            onClick={event => {
              if (!onOpenAuthorization) return;
              event.preventDefault();
              onOpenAuthorization();
            }}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Sign in to {providerName}
          </a>
          {mode === "hosted_redirect" ? " then paste the redirect URL below"
            : mode === "browser_redirect" ? " then return here"
            : mode === "submitted_code"
            ? " then come back and enter authorization code"
            : " by providing the authorization code below"}
        </>
      )}
    >
      {failure && (
        <div className="flex flex-col items-start gap-3 px-2">
          <p role="alert" className="text-sm text-muted-foreground">{failureMessage ?? "Retry sign-in to get a fresh code. Your setup is saved."}</p>
          {onRetry && <Button type="button" variant="outline" onClick={onRetry}>Retry sign-in</Button>}
        </div>
      )}
      {children}
    </OnboardingLoginCard>
  );
}

export function ProviderApiKeyCard({
  providerName,
  ...field
}: Omit<Parameters<typeof OnboardingCardField>[0], "masked" | "label"> & {
  providerName: string;
}) {
  return (
    <OnboardingLoginCard
      instruction={`Provide your ${providerName} API key to connect`}
    >
      <OnboardingCardField {...field} label="API key" masked />
    </OnboardingLoginCard>
  );
}

function isHttpAuthorizationUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export type LocalLoginPrimaryAction =
  | { kind: "retry"; label: string; icon: "arrow"; disabled: false }
  | { kind: "open_sign_in"; label: string; icon: "none"; disabled: false; url: string }
  | { kind: "connecting"; label: string; icon: "spinner"; disabled: true }
  | { kind: "preparing"; label: string; icon: "spinner"; disabled: true }
  | { kind: "waiting"; label: string; icon: "arrow"; disabled: true }
  | null;

/** Maps local/hosted sign-in state to the step footer's primary CTA. */
export function resolveLocalLoginPrimaryAction({
  adapterType,
  login,
  submitting = false,
}: {
  adapterType: string;
  login?: {
    isolated?: boolean;
    authorizationUrl?: string | null;
    preparing: boolean;
    status?: "ready" | "sign_in_required" | "expired" | null;
    error: string | null;
  };
  submitting?: boolean;
}): LocalLoginPrimaryAction {
  if (!login || login.status === "ready") return null;
  const browserLogin = adapterType === "claude_local" || adapterType === "codex_local" || adapterType === "antigravity_runtime";
  if (login.preparing) {
    return { kind: "preparing", label: "Preparing sign-in…", icon: "spinner", disabled: true };
  }
  if (Boolean(login.error) || login.status === "expired") {
    return {
      kind: "retry",
      label: login.isolated === false ? "Check again" : "Start sign in",
      icon: "arrow",
      disabled: false,
    };
  }
  if (submitting) {
    return { kind: "connecting", label: "Connecting", icon: "spinner", disabled: true };
  }
  if (browserLogin && isHttpAuthorizationUrl(login.authorizationUrl)) {
    return {
      kind: "open_sign_in",
      label: `Sign in to ${connectSourceName(adapterType)}`,
      icon: "none",
      disabled: false,
      url: login.authorizationUrl,
    };
  }
  if (browserLogin && !login.authorizationUrl) {
    return { kind: "preparing", label: "Preparing sign-in…", icon: "spinner", disabled: true };
  }
  return { kind: "waiting", label: "Connect", icon: "arrow", disabled: true };
}

/** Shared controller hook that wires local/hosted sign-in state to a host's FooterNav primary CTA. */
export function useLocalLoginPrimaryAction({
  enabled,
  adapterType,
  login,
  onBeforeRetry,
}: {
  enabled: boolean;
  adapterType: string;
  login: {
    isolated?: boolean;
    authorizationUrl?: string | null;
    preparing: boolean;
    status?: "ready" | "sign_in_required" | "expired" | null;
    error: string | null;
    retry: () => void;
  };
  onBeforeRetry?: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const action = enabled
    ? resolveLocalLoginPrimaryAction({ adapterType, login, submitting })
    : null;
  function runPrimary(): boolean {
    if (!action) return false;
    if (action.kind === "retry") {
      onBeforeRetry?.();
      login.retry();
    } else if (action.kind === "open_sign_in") {
      window.open(action.url, "_blank", "noreferrer,noopener");
    }
    return true;
  }
  return {
    action,
    runPrimary,
    resetSubmitting: () => setSubmitting(false),
    instructionsProps: {
      primaryHandlesRetry: true,
      onSubmittingChange: setSubmitting,
    },
  };
}

/** Shared instructions for local subscription setup in every authentication host. */
export function LocalProviderLoginInstructions({ adapterType, login, hostedRedirect = false, primaryHandlesRetry = false, onSubmittingChange }: {
  adapterType: string;
  hostedRedirect?: boolean | "optional";
  /** Omit the inline retry link when an error/expiry is already surfaced on the primary footer CTA. */
  primaryHandlesRetry?: boolean;
  onSubmittingChange?: (submitting: boolean) => void;
  login?: { isolated?: boolean; command?: string; authorizationUrl?: string | null; code?: string | null; accountLabel?: string | null; submitCode?: (code: string) => Promise<void>; preparing: boolean; status?: "ready" | "sign_in_required" | "expired" | null; error: string | null; retry: () => void };
}) {
  const [showCommand, setShowCommand] = useState(false);
  const [browserCode, setBrowserCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [codeSubmitted, setCodeSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const codeSubmissionRef = useRef<symbol | null>(null);
  useEffect(() => {
    codeSubmissionRef.current = null;
    setBrowserCode("");
    setSubmitting(false);
    setCodeSubmitted(false);
    setSubmitError(null);
  }, [login?.authorizationUrl, login?.preparing]);
  useEffect(() => {
    onSubmittingChange?.(submitting || codeSubmitted);
  }, [submitting, codeSubmitted, onSubmittingChange]);
  useEffect(() => () => onSubmittingChange?.(false), [onSubmittingChange]);
  const provider = adapterType === "antigravity_runtime" ? "Antigravity" : adapterType === "claude_local" ? "Claude Code" : adapterType === "grok_local" ? "Grok CLI" : "Codex CLI";
  const isolated = login?.isolated ?? (adapterType === "codex_local" || adapterType === "grok_local");
  const command = login?.command;
  const browserLogin = adapterType === "claude_local" || adapterType === "codex_local" || adapterType === "antigravity_runtime";
  const hostedGoogleRedirect = adapterType === "antigravity_runtime" && Boolean(hostedRedirect);
  const optionalHostedGoogleRedirect = adapterType === "antigravity_runtime" && hostedRedirect === "optional";
  async function submitBrowserCode(value = browserCode) {
    if (!value.trim() || !login?.submitCode || codeSubmissionRef.current) return;
    const submission = Symbol();
    codeSubmissionRef.current = submission;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await login.submitCode(value.trim());
      if (codeSubmissionRef.current !== submission) return;
      setBrowserCode("");
      setCodeSubmitted(true);
    } catch (cause) {
      // The login hook presents attempt-level errors beside the sign-in card;
      // hosted Google redirect keeps the field open for retryable paste errors.
      if (codeSubmissionRef.current === submission) {
        codeSubmissionRef.current = null;
        if (hostedGoogleRedirect) setSubmitError(describeError(cause).body);
      }
    } finally {
      if (codeSubmissionRef.current === submission || codeSubmissionRef.current === null) setSubmitting(false);
    }
  }
  function pasteBrowserCode(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData?.getData("text");
    if (!pasted?.trim()) return;
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const value = input.value.slice(0, start) + pasted + input.value.slice(end);
    event.preventDefault();
    setSubmitError(null);
    setBrowserCode(value);
    void submitBrowserCode(value);
  }
  if (login?.preparing) return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Preparing sign-in…</p>;
  const ready = login?.status === "ready";
  const needsRetry = Boolean(login?.error) || login?.status === "expired";
  const safeAuthorizationUrl = isHttpAuthorizationUrl(login?.authorizationUrl) ? login.authorizationUrl : null;
  const awaitingBrowserSignIn = browserLogin && !ready && !login?.authorizationUrl && !needsRetry;
  const showInlineRetry = Boolean(login && !login.preparing && !ready && !awaitingBrowserSignIn && (isolated || login.error) && !(primaryHandlesRetry && needsRetry));
  return <div className="min-w-0 max-w-full space-y-3 text-sm text-muted-foreground">
    {ready ? <>
      <p role="status" className={cn("flex items-center gap-2 text-foreground", ANALYTICS_MASK_CLASS)}><Check className="size-4 shrink-0 text-(--status-task-icon-done)" />{login?.accountLabel ?? provider} is signed in. Click Connect to use this account.</p>
      {!showCommand && <button type="button" className="underline underline-offset-4" onClick={() => browserLogin ? login?.retry() : setShowCommand(true)}>Use a different account</button>}
    </> : !browserLogin && <p>{isolated ? `Sign in to ${provider} for this connection on the machine running Paperclip. Your existing terminal login stays separate.` : `Connect uses your local ${provider} account on the machine running Paperclip.`}</p>}
    {awaitingBrowserSignIn && <p role="status">Preparing browser sign-in…</p>}
    {(submitting || codeSubmitted) && !ready && !needsRetry && <p role="status">Finishing sign-in…</p>}
    {browserLogin && !ready && !submitting && !codeSubmitted && !needsRetry && safeAuthorizationUrl && <ProviderSubscriptionCard
      providerName={connectSourceName(adapterType)}
      authorizationUrl={safeAuthorizationUrl}
      mode={hostedGoogleRedirect && !optionalHostedGoogleRedirect ? "hosted_redirect" : adapterType === "antigravity_runtime" ? "browser_redirect" : adapterType === "claude_local" ? "submitted_code" : "displayed_code"}
    >
      {adapterType === "claude_local" ? <div className="flex flex-col gap-2">
        <OnboardingCardField
          value={browserCode}
          onChange={setBrowserCode}
          onPaste={pasteBrowserCode}
          onSubmit={() => void submitBrowserCode()}
          disabled={submitting}
        />
        <Button type="button" disabled={!browserCode.trim() || submitting} onClick={() => void submitBrowserCode()}>Submit code</Button>
      </div> : hostedGoogleRedirect ? <div className="flex flex-col gap-2">
        <p className="px-2 text-xs text-muted-foreground">
          {optionalHostedGoogleRedirect
            ? <>Finish signing in in the Antigravity browser window, then return here. If your browser is on another machine and the <code className="font-mono">127.0.0.1</code> redirect page won’t load, copy the full URL from your address bar and paste it below.</>
            : <>After signing in to Antigravity, your browser will redirect to a <code className="font-mono">127.0.0.1</code> page that won’t load. Copy the full URL from your browser’s address bar and paste it below.</>}
        </p>
        <OnboardingCardField
          label="Antigravity redirect URL"
          placeholder="Paste http://127.0.0.1:... URL here"
          className={cn(ANALYTICS_MASK_CLASS, ANALYTICS_NO_CAPTURE_CLASS)}
          value={browserCode}
          onChange={(value) => {
            setSubmitError(null);
            setBrowserCode(value);
          }}
          onPaste={pasteBrowserCode}
          onSubmit={() => void submitBrowserCode()}
          disabled={submitting}
        />
        <Button type="button" disabled={!browserCode.trim() || submitting} onClick={() => void submitBrowserCode()}>Submit redirect URL</Button>
        {submitError && <p role="alert" className="px-2 text-xs text-destructive">{submitError}</p>}
      </div> : adapterType === "antigravity_runtime" ? <p>Finish signing in in the Antigravity browser window, then return here.</p> : <OnboardingLoginCodeRow code={login?.code ?? ""} />}
    </ProviderSubscriptionCard>}
    {!browserLogin && (!ready || showCommand) && !needsRetry && <>
      <p>Run this in a terminal on that machine and finish signing in in your browser. We’ll check automatically when you return.</p>
      {command && <div className="flex min-w-0 max-w-full items-start gap-2 rounded-md border bg-muted p-3 text-foreground">
        <pre className={cn("min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs", ANALYTICS_NO_CAPTURE_CLASS)}><code>{command}</code></pre>
        <LoginCardCopyButton value={command} label="Copy sign-in command" />
      </div>}
    </>}
    {login?.error && <p role="alert">{login.error}</p>}
    {showInlineRetry && <button type="button" className="underline underline-offset-4" onClick={login!.retry}>{isolated ? "Start sign-in again" : "Check again"}</button>}
  </div>;
}
