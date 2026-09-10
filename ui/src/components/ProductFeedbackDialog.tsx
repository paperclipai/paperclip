import { useRef, useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, LoaderCircle } from "lucide-react";
import {
  PRODUCT_FEEDBACK_SCHEMA_VERSION,
  type DeploymentMode,
  type ProductFeedbackCapability,
} from "@paperclipai/shared";
import { productFeedbackApi, ProductFeedbackApiError } from "@/api/productFeedback";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  clearProductFeedbackDiagnostics,
  getBrowserSummary,
  getOperatingSystemSummary,
  normalizeFeedbackRoute,
  readProductFeedbackDiagnostics,
  recordProductFeedbackDiagnostic,
} from "@/lib/product-feedback-diagnostics";

type FeedbackStatus = "editing" | "submitting" | "error" | "success";

interface ProductFeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  capability: ProductFeedbackCapability;
  deploymentMode: DeploymentMode;
  knownEmail?: string | null;
  appVersion?: string | null;
  companyId: string;
  submitFeedback?: typeof productFeedbackApi.submit;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

export function ProductFeedbackDialog({
  open,
  onOpenChange,
  capability,
  deploymentMode,
  knownEmail,
  appVersion = null,
  companyId,
  submitFeedback = productFeedbackApi.submit,
}: ProductFeedbackDialogProps) {
  const accountEmail = deploymentMode === "authenticated" ? knownEmail?.trim() || null : null;
  const [feedback, setFeedback] = useState("");
  const [followUpConsent, setFollowUpConsent] = useState(true);
  const [changeEmail, setChangeEmail] = useState(false);
  const [email, setEmail] = useState(accountEmail ?? "");
  const [status, setStatus] = useState<FeedbackStatus>("editing");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const submissionIdRef = useRef(globalThis.crypto.randomUUID());

  const maxLength = capability.limits.feedbackMaxLength;
  const trimmedFeedback = feedback.trim();
  const selectedEmail = followUpConsent
    ? (accountEmail && !changeEmail ? accountEmail : email.trim())
    : "";
  const feedbackInvalid = trimmedFeedback.length === 0 || trimmedFeedback.length > maxLength;
  const emailInvalid = followUpConsent && !validEmail(selectedEmail);
  const submitting = status === "submitting";

  function submissionContext() {
    const userAgent = navigator.userAgent;
    return {
      routeTemplate: normalizeFeedbackRoute(window.location.pathname),
      appVersion,
      deploymentMode,
      browser: getBrowserSummary(userAgent),
      operatingSystem: getOperatingSystemSummary(userAgent),
    };
  }

  function resetForNextSubmission() {
    setFeedback("");
    setFollowUpConsent(true);
    setChangeEmail(false);
    setEmail(accountEmail ?? "");
    setStatus("editing");
    setErrorMessage(null);
    submissionIdRef.current = crypto.randomUUID();
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      if (status === "success") resetForNextSubmission();
      onOpenChange(true);
      return;
    }

    if (submitting) return;
    if (status === "success") resetForNextSubmission();
    onOpenChange(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (feedbackInvalid || emailInvalid || submitting) return;

    setStatus("submitting");
    setErrorMessage(null);
    try {
      const diagnostics = readProductFeedbackDiagnostics();
      await submitFeedback({
        companyId,
        schemaVersion: PRODUCT_FEEDBACK_SCHEMA_VERSION,
        submissionId: submissionIdRef.current,
        submittedAt: new Date().toISOString(),
        feedback: trimmedFeedback,
        followUpConsent,
        ...(followUpConsent ? { reporterEmail: selectedEmail } : {}),
        context: {
          ...submissionContext(),
          diagnostics,
        },
      });
      clearProductFeedbackDiagnostics();
      setStatus("success");
    } catch (error) {
      const message = error instanceof ProductFeedbackApiError
        ? error.message
        : "Feedback could not be sent. Your draft is still here. Try again.";
      recordProductFeedbackDiagnostic({ code: "feedback_submit_failed", component: "feedback_dialog" });
      setErrorMessage(message);
      setStatus("error");
    }
  }

  if (!capability.enabled) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-(--sz-calc-18) overflow-y-auto sm:max-w-xl"
        showCloseButton={!submitting}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          feedbackRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => submitting && event.preventDefault()}
        onPointerDownOutside={(event) => submitting && event.preventDefault()}
      >
        {status === "success" ? (
          <div className="flex flex-col items-center gap-4 py-4 text-center" role="status" aria-live="polite">
            <span className="rounded-full bg-primary/10 p-3 text-primary">
              <CheckCircle2 className="size-6" aria-hidden="true" />
            </span>
            <div className="space-y-2">
              <DialogTitle>Feedback sent</DialogTitle>
              <DialogDescription>
                Thank you. Your feedback is ready for the Paperclip product team.
              </DialogDescription>
            </div>
            <Button type="button" onClick={() => handleOpenChange(false)}>Done</Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5" noValidate aria-busy={submitting}>
            <DialogHeader>
              <DialogTitle>Share feedback</DialogTitle>
              <DialogDescription>
                Share a bug, request, or idea. We’ll use product context to help investigate.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label htmlFor="product-feedback-body">What could Paperclip do better?</Label>
              <Textarea
                ref={feedbackRef}
                id="product-feedback-body"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                maxLength={maxLength}
                rows={6}
                disabled={submitting}
                aria-invalid={feedback.length > 0 && feedbackInvalid}
                aria-describedby="product-feedback-count"
                placeholder="Tell us what happened or what would make Paperclip more useful."
              />
              <p id="product-feedback-count" className="text-right font-mono text-xs text-muted-foreground">
                {feedback.length.toLocaleString()} / {maxLength.toLocaleString()}
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="product-feedback-follow-up"
                  checked={followUpConsent}
                  onCheckedChange={(checked) => setFollowUpConsent(checked === true)}
                  disabled={submitting}
                />
                <Label htmlFor="product-feedback-follow-up" className="leading-snug">
                  Would you like us to follow up with you regarding this feedback?
                </Label>
              </div>

              {followUpConsent && accountEmail && !changeEmail ? (
                <div className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2 text-sm">
                  <span className="min-w-0 truncate text-muted-foreground">
                    We’ll use <span className="font-medium text-foreground">{accountEmail}</span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEmail(accountEmail);
                      setChangeEmail(true);
                    }}
                  >
                    Change
                  </Button>
                </div>
              ) : null}

              {followUpConsent && (!accountEmail || changeEmail) ? (
                <div className="space-y-2">
                  <Label htmlFor="product-feedback-email">Email for follow-up</Label>
                  <Input
                    id="product-feedback-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    disabled={submitting}
                    required
                    aria-required="true"
                    aria-invalid={email.length > 0 && emailInvalid}
                    aria-describedby="product-feedback-email-help"
                    placeholder="you@example.com"
                  />
                  <p
                    id="product-feedback-email-help"
                    className={emailInvalid && email.length > 0 ? "text-sm text-destructive" : "text-xs text-muted-foreground"}
                  >
                    {emailInvalid && email.length > 0
                      ? "Enter a complete email address, or turn off follow-up."
                      : "Required while follow-up is on."}
                  </p>
                </div>
              ) : null}
            </div>

            <details className="group rounded-md bg-muted/60 px-3 py-3 text-sm text-muted-foreground">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium text-foreground">
                What diagnostic details are sent?
                <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <ul className="mt-3 list-disc space-y-1 pl-5">
                <li>Paperclip version, deployment mode, and page route without query details</li>
                <li>Browser and operating-system family with major version</li>
                <li>Up to five recent sanitized Paperclip error codes</li>
                <li>A random submission ID used to make retries safe</li>
              </ul>
            </details>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Submitting sends this feedback and the diagnostic details listed here to Paperclip&apos;s feedback
              systems. If you consent to follow-up, your email is encrypted separately and is never sent to PostHog.
            </p>

            {errorMessage ? (
              <div className="flex items-start gap-3 rounded-md bg-destructive/10 px-3 py-3 text-sm text-destructive" role="alert">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <p>{errorMessage}</p>
              </div>
            ) : null}

            <p className="sr-only" role="status" aria-live="polite">
              {submitting ? "Sending feedback. Please wait." : ""}
            </p>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={feedbackInvalid || emailInvalid || submitting}>
                {submitting ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                {submitting ? "Sending feedback…" : status === "error" ? "Try again" : "Send feedback"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
