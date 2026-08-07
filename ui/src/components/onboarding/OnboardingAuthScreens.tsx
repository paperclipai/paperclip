// Presentational-only auth screens (create account + email OTP), ported from
// the prototype onto the repo's design tokens. These are NOT wired to real
// auth — the app authenticates via better-auth upstream of onboarding. They
// exist so the full onboarding visual arc can be previewed. See the preview
// harness (onboarding-preview-main.tsx).
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { OnboardingCard, OnboardingHeading } from "./OnboardingPrimitives";

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.5 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-2 3.2-4.9 3.2-7.9z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.9 0 5.4-1 7.2-2.6l-3.6-2.7c-1 .7-2.3 1.1-3.6 1.1-2.8 0-5.1-1.9-6-4.4H2.3v2.8A11 11 0 0 0 12 23z"
      />
      <path fill="#FBBC05" d="M6 14.4a6.6 6.6 0 0 1 0-4.2V7.4H2.3a11 11 0 0 0 0 9.8L6 14.4z" />
      <path
        fill="#EA4335"
        d="M12 5.4c1.6 0 3 .5 4.1 1.6l3.1-3.1A11 11 0 0 0 2.3 7.4L6 10.2c.9-2.6 3.2-4.8 6-4.8z"
      />
    </svg>
  );
}

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2A10 10 0 0 0 8.8 21.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.5-1.1-4.5-4.9 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.8-2.3 4.6-4.5 4.9.4.3.7.9.7 1.8v2.7c0 .3.2.6.7.5A10 10 0 0 0 12 2z"
      />
    </svg>
  );
}

function SocialButton({ mark, label }: { mark: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      className="flex flex-1 items-center justify-center gap-2.5 rounded-md border border-border bg-muted/30 px-3 py-3 text-sm font-medium text-foreground transition-colors hover:border-muted-foreground"
    >
      <span className="size-(--sz-18px)">{mark}</span>
      {label}
    </button>
  );
}

/** Create-account screen (visual only). */
export function AccountScreen({ onContinue }: { onContinue?: () => void }) {
  return (
    <OnboardingCard translucent>
      <div className="space-y-6">
        <OnboardingHeading
          title="Create an account"
          lede="Free while Paperclip is in beta. No credit card required."
          center
        />
        <div className="space-y-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="onboarding-auth-email">Email</Label>
            <Input id="onboarding-auth-email" type="email" placeholder="you@company.com" />
            <span className="text-xs leading-snug text-muted-foreground">
              We'll send you a 6-digit code to confirm your email.
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="onboarding-auth-password">Password</Label>
            <Input id="onboarding-auth-password" type="password" placeholder="••••••••" />
            <span className="text-xs leading-snug text-muted-foreground">At least 8 characters.</span>
          </div>
          <Button size="lg" className="w-full rounded-full" onClick={onContinue}>
            Continue
          </Button>
        </div>
        <div className="flex items-center gap-3.5 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          Or continue with
          <span className="h-px flex-1 bg-border" />
        </div>
        <div className="flex gap-3">
          <SocialButton mark={<GoogleMark className="size-(--sz-18px)" />} label="Google" />
          <SocialButton mark={<GithubMark className="size-(--sz-18px)" />} label="GitHub" />
        </div>
        <p className="text-center text-xs text-muted-foreground">
          Already have an account?{" "}
          <span className="text-foreground underline-offset-2 hover:underline">Sign in</span>
        </p>
      </div>
    </OnboardingCard>
  );
}

/** Email OTP confirmation screen (visual only). */
export function OtpScreen({ email, onContinue }: { email?: string; onContinue?: () => void }) {
  const [vals, setVals] = useState<string[]>(["", "", "", "", "", ""]);
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  function setAt(i: number, v: string) {
    setVals((a) => a.map((x, k) => (k === i ? v : x)));
  }
  function onChange(i: number, raw: string) {
    const v = raw.replace(/\D/g, "").slice(0, 1);
    setAt(i, v);
    if (v && i < 5) refs.current[i + 1]?.focus();
  }
  function onKeyDown(i: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !vals[i] && i > 0) refs.current[i - 1]?.focus();
  }

  const filled = vals.every(Boolean);

  return (
    <OnboardingCard translucent>
      <div className="flex flex-col items-center gap-6">
        <OnboardingHeading
          title="Confirm your email"
          lede={
            <>
              Enter the 6-digit code we sent to{" "}
              <span className="text-foreground">{email || "your inbox"}</span>.
            </>
          }
          center
        />
        <div className="flex justify-center gap-2.5">
          {vals.map((v, i) => (
            <input
              key={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              inputMode="numeric"
              maxLength={1}
              value={v}
              onChange={(e) => onChange(i, e.target.value)}
              onKeyDown={(e) => onKeyDown(i, e)}
              className="size-(--sz-52px) rounded-md border border-input bg-muted/30 text-center font-mono text-xl font-semibold text-foreground outline-none transition-shadow focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)"
            />
          ))}
        </div>
        <Button size="lg" className={cn("w-full rounded-full")} disabled={!filled} onClick={onContinue}>
          Continue
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Didn't get it?{" "}
          <span className="text-foreground underline-offset-2 hover:underline">Resend code</span>
          {" · "}
          <span className="text-foreground underline-offset-2 hover:underline">
            Use a different email
          </span>
        </p>
      </div>
    </OnboardingCard>
  );
}
