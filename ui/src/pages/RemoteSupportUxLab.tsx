import { useState } from "react";
import {
  ArrowRight,
  Battery,
  Check,
  CircleStop,
  Clock3,
  LockKeyhole,
  Monitor,
  ShieldCheck,
  Smartphone,
  Video,
  Wifi,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type PhoneId = "maya" | "jordan";
type ControlApproval = "not-requested" | "pending" | "approved" | "denied";
type ScreenApproval = "approved" | "pending";

const DEMO_PHONES = {
  maya: {
    id: "maya",
    owner: "Maya Chen",
    initials: "MC",
    model: "Pixel 9",
    platform: "Android",
    version: "Android 15",
    consent: "Screen sharing approved",
  },
  jordan: {
    id: "jordan",
    owner: "Jordan Lee",
    initials: "JL",
    model: "iPhone 15",
    platform: "iPhone",
    version: "iOS 19",
    consent: "Screen sharing approved",
  },
} as const;

function PhoneScreenPreview({ owner }: { owner: string }) {
  return (
    <div className="mx-auto w-full max-w-64 rounded-xl border border-border bg-background p-2 shadow-sm">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
          <span>9:41</span>
          <div className="flex items-center gap-1.5" aria-label="Demo phone status">
            <Wifi className="size-3" aria-hidden />
            <Battery className="size-3" aria-hidden />
          </div>
        </div>
        <div className="space-y-4 px-4 pb-5 pt-3">
          <div>
            <p className="text-xs text-muted-foreground">Welcome back</p>
            <p className="text-sm font-semibold">{owner}&rsquo;s phone</p>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-xs font-medium">Display settings</p>
            <p className="mt-1 text-xs text-muted-foreground">Brightness and text size</p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full w-2/3 rounded-full bg-primary" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span>Text size</span>
              <span className="text-muted-foreground">Default</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span>Auto brightness</span>
              <span className="text-muted-foreground">On</span>
            </div>
          </div>
          <div className="rounded-md bg-primary/10 px-3 py-2 text-center text-xs text-primary">
            Example screen only
          </div>
        </div>
      </div>
    </div>
  );
}

export function RemoteSupportUxLab() {
  const [selectedPhoneId, setSelectedPhoneId] = useState<PhoneId>("maya");
  const [controlApproval, setControlApproval] = useState<ControlApproval>("not-requested");
  const [screenApproval, setScreenApproval] = useState<ScreenApproval>("approved");
  const [ownerView, setOwnerView] = useState(false);
  const [sessionActive, setSessionActive] = useState(true);
  const phone = DEMO_PHONES[selectedPhoneId];
  const controlSupported = selectedPhoneId === "maya";

  function selectPhone(phoneId: PhoneId) {
    if (phoneId === selectedPhoneId) return;
    setSelectedPhoneId(phoneId);
    setControlApproval("not-requested");
    setScreenApproval("approved");
    setOwnerView(false);
    setSessionActive(true);
  }

  function endSession() {
    setSessionActive(false);
    setControlApproval("not-requested");
    setOwnerView(false);
  }

  function startDemoSession() {
    setSessionActive(true);
    setControlApproval("not-requested");
    setScreenApproval("pending");
    setOwnerView(true);
  }

  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="size-5" aria-hidden />
            </div>
            <div>
              <p className="text-sm font-semibold">Relay support</p>
              <p className="text-xs text-muted-foreground">Owner-approved phone sessions</p>
            </div>
          </div>
          <Badge variant="outline" className="gap-1.5 px-3 py-1.5">
            <Monitor className="size-3.5" aria-hidden />
            UI prototype
          </Badge>
        </header>

        <section className="flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-xl font-bold">Remote support</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Help someone with their phone while they stay in control of access.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LockKeyhole className="size-4" aria-hidden />
            Screen sharing and control require the owner&rsquo;s approval
          </div>
        </section>

        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4"
        >
          <Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-sm font-medium">Demo only — no phone is connected</p>
            <p className="mt-1 text-sm text-muted-foreground">
              The preview and approval buttons change local demo state only. They do not capture a screen,
              grant permissions, or send device input.
            </p>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="h-fit">
            <CardHeader>
              <CardTitle className="text-sm">Support sessions</CardTitle>
              <p className="text-sm text-muted-foreground">
                Each example has an owner-approved screen share.
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {Object.values(DEMO_PHONES).map((demoPhone) => {
                const isSelected = selectedPhoneId === demoPhone.id;
                return (
                  <button
                    key={demoPhone.id}
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`${demoPhone.owner}, ${demoPhone.model}, ${demoPhone.platform}`}
                    onClick={() => selectPhone(demoPhone.id)}
                    className={cn(
                      "w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isSelected ? "border-primary bg-accent/40" : "border-border",
                    )}
                  >
                    <span className="flex items-start gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                        {demoPhone.initials}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{demoPhone.owner}</span>
                          <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {demoPhone.model} · {demoPhone.version}
                        </span>
                        <span className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Video className="size-3.5" aria-hidden />
                          {demoPhone.consent}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
              <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                <Clock3 className="size-3.5" aria-hidden />
                Demo session expires in 08:42
              </div>
            </CardContent>
          </Card>

          <Card className="min-w-0 lg:col-span-2">
            <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-full bg-muted text-sm font-semibold">
                  {phone.initials}
                </div>
                <div>
                  <CardTitle className="text-sm">{phone.owner}</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {phone.model} · {phone.version}
                  </p>
                </div>
                <Badge variant="outline" className="ml-1 gap-1.5">
                  <span className="size-1.5 rounded-full bg-primary" />
                  {!sessionActive
                    ? "Session ended"
                    : screenApproval === "pending"
                      ? "Waiting for owner"
                      : "Connected · demo"}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={ownerView ? "outline" : "secondary"}
                  onClick={() => setOwnerView((current) => !current)}
                  disabled={!sessionActive}
                >
                  <Smartphone aria-hidden />
                  {ownerView ? "Back to support view" : "View owner approval"}
                </Button>
                {sessionActive ? (
                  <Button type="button" size="sm" variant="outline" onClick={endSession}>
                    <CircleStop aria-hidden />
                    End session
                  </Button>
                ) : (
                  <Button type="button" size="sm" onClick={startDemoSession}>
                    Start new demo
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {!sessionActive ? (
                <div className="rounded-lg border border-dashed border-border px-6 py-14 text-center">
                  <CircleStop className="mx-auto size-8 text-muted-foreground" aria-hidden />
                  <h2 className="mt-3 text-sm font-semibold">Support session ended</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    A new session requires the phone owner to approve screen sharing again.
                  </p>
                </div>
              ) : ownerView ? (
                <div className="mx-auto max-w-xl rounded-lg border border-border bg-muted/20 p-5 sm:p-7">
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <LockKeyhole className="size-5" aria-hidden />
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Phone owner view
                      </p>
                      <h2 className="mt-1 text-lg font-semibold">
                        {screenApproval === "pending"
                          ? "Allow screen sharing for this session?"
                          : controlApproval === "pending"
                            ? "Allow the support helper to control your phone?"
                            : controlApproval === "approved"
                              ? "Control access approved"
                              : controlApproval === "denied"
                                ? "Control access declined"
                                : "Your screen is being shared"}
                      </h2>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {screenApproval === "pending"
                          ? "The helper can only see your screen after you approve. You can end sharing at any time."
                          : controlApproval === "pending"
                            ? "Review this request. You can approve it for this session or decline and continue with screen sharing only."
                            : "You can end screen sharing at any time. This prototype does not connect to a real phone."}
                      </p>
                    </div>
                  </div>
                  {screenApproval === "pending" ? (
                    <div className="mt-5 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        onClick={() => {
                          setScreenApproval("approved");
                          setOwnerView(false);
                        }}
                      >
                        <Check aria-hidden />
                        Approve screen sharing
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setSessionActive(false)}
                      >
                        <X aria-hidden />
                        Decline and end session
                      </Button>
                    </div>
                  ) : controlApproval === "pending" ? (
                    <div className="mt-5 flex flex-wrap gap-2">
                      <Button type="button" onClick={() => setControlApproval("approved")}>
                        <Check aria-hidden />
                        Approve for this session
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setControlApproval("denied")}
                      >
                        <X aria-hidden />
                        Decline
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-5 text-xs text-muted-foreground">
                      {controlApproval === "approved"
                        ? "Approval is limited to this demo session."
                        : controlApproval === "denied"
                          ? "The helper can continue with screen sharing only."
                          : "No control request is waiting for your decision."}
                    </p>
                  )}
                </div>
              ) : screenApproval === "pending" ? (
                <div
                  role="status"
                  className="rounded-lg border border-dashed border-border px-6 py-14 text-center"
                >
                  <LockKeyhole className="mx-auto size-8 text-muted-foreground" aria-hidden />
                  <h2 className="mt-3 text-sm font-semibold">Waiting for screen-sharing approval</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    The phone owner must approve on their phone before a screen can be shared.
                  </p>
                </div>
              ) : (
                <div className="grid gap-6 xl:grid-cols-2">
                  <section className="rounded-lg border border-border bg-muted/20 p-4 sm:p-5">
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">Shared screen preview</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Example screen · no live video
                        </p>
                      </div>
                      <Badge variant="outline" className="gap-1.5">
                        <Video className="size-3.5" aria-hidden />
                        Owner approved
                      </Badge>
                    </div>
                    <PhoneScreenPreview owner={phone.owner} />
                  </section>

                  <div className="space-y-4">
                    <section className="rounded-lg border border-border p-4">
                      <div className="flex items-start gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <ShieldCheck className="size-4" aria-hidden />
                        </div>
                        <div>
                          <h2 className="text-sm font-semibold">Permission summary</h2>
                          <p className="mt-1 text-sm text-muted-foreground">
                            The owner approved screen sharing. Control is a separate, optional permission.
                          </p>
                        </div>
                      </div>
                      <div className="mt-4 space-y-3 border-t border-border pt-4">
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <span className="text-muted-foreground">Screen sharing</span>
                          <span className="inline-flex items-center gap-1.5 font-medium">
                            <Check className="size-4 text-primary" aria-hidden />
                            Approved
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <span className="text-muted-foreground">Phone control</span>
                          <span className="font-medium">
                            {controlApproval === "approved"
                              ? "Owner approved · demo"
                              : controlApproval === "pending"
                                ? "Waiting for owner"
                                : controlApproval === "denied"
                                  ? "Declined by owner"
                                  : "Not granted"}
                          </span>
                        </div>
                      </div>
                    </section>

                    <section className="rounded-lg border border-border p-4">
                      <h2 className="text-sm font-semibold">Control request</h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Ask the owner for a separate, session-only approval. They can decline without ending
                        screen sharing.
                      </p>
                      {controlSupported ? (
                        <div className="mt-4 space-y-3">
                          {controlApproval === "not-requested" ? (
                            <Button
                              type="button"
                              className="w-full"
                              onClick={() => setControlApproval("pending")}
                            >
                              Request control access
                            </Button>
                          ) : controlApproval === "pending" ? (
                            <div
                              role="status"
                              className="rounded-md border border-border bg-muted/40 p-3 text-sm"
                            >
                              Waiting for {phone.owner} to approve on their phone.
                            </div>
                          ) : (
                            <div
                              role="status"
                              className="rounded-md border border-border bg-muted/40 p-3 text-sm"
                            >
                              {controlApproval === "approved"
                                ? "The owner approved this demo request. No phone input is enabled."
                                : "The owner declined. Continue with screen sharing only."}
                            </div>
                          )}
                          <p className="text-xs text-muted-foreground">
                            A real Android app would also require the owner to enable the relevant OS
                            accessibility permission. This demo grants none.
                          </p>
                        </div>
                      ) : (
                        <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                          Control is not included for iPhone in this prototype. Continue with owner-approved
                          screen sharing and verbal guidance.
                        </div>
                      )}
                    </section>

                    <p className="flex items-start gap-2 text-xs text-muted-foreground">
                      <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      The phone owner can decline control or end the session at any time.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
