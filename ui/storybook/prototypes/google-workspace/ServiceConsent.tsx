import { useState } from "react";
import { Check, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AppLogo } from "@/pages/apps/AppLogo";
import { GoogleWorkspaceServiceFields } from "@/features/connections/GoogleWorkspaceServices";
import { GOOGLE_WORKSPACE_DEFAULT_SELECTION, GOOGLE_WORKSPACE_SERVICE_GROUPS, googleWorkspaceSelectedScopes } from "@paperclipai/shared";

const permissionDetails = {
  gmail: "Google’s compose permission also permits sending email. Paperclip currently exposes draft creation, not sending.",
  drive: "Read files across Drive; create files opened or created with this app, and edit documents, spreadsheets, and presentations.",
  calendar: "Managing events includes creating, changing, deleting, and responding to events.",
};
export const services = GOOGLE_WORKSPACE_SERVICE_GROUPS.map(group => ({ ...group, slug: group.brandKey, warning: permissionDetails[group.id] }));
export type Selection = Partial<Record<string, "read" | "write">>;
export const defaultSelection: Selection = GOOGLE_WORKSPACE_DEFAULT_SELECTION;
export function selectedScopes(selection: Selection) {
  return googleWorkspaceSelectedScopes(selection);
}

export function ServiceConsent({ initial = defaultSelection, existing = false, error = false, start = "services" }: {
  initial?: Selection; existing?: boolean; error?: boolean; start?: "catalog" | "services" | "review";
}) {
  const [selection, setSelection] = useState<Selection>(initial);
  const [open, setOpen] = useState(start !== "catalog");
  const [step, setStep] = useState<"services" | "review">(start === "review" ? "review" : "services");
  const [handoff, setHandoff] = useState(false);
  const [failed, setFailed] = useState(false);
  const scopes = selectedScopes(selection);
  const previousScopes = selectedScopes(existing ? initial : {});
  const added = scopes.filter(scope => !previousScopes.includes(scope));
  const chosen = services.filter(service => selection[service.id]);
  const warnings = chosen.filter(service => service.warning && selection[service.id] === "write");
  return <main className="min-h-screen bg-background text-foreground">
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center justify-between"><h1 className="text-xl font-bold">Apps</h1><span className="text-sm text-muted-foreground">Paperclip</span></header>
      <h2 className="text-sm font-medium">Connectors</h2>
      <article className="max-w-md space-y-4 rounded-lg border p-4">
        <div className="flex items-center gap-3"><AppLogo name="Google Workspace" brandKey="google" size={40} /><div><h3 className="text-sm font-semibold">Google Workspace</h3><p className="text-xs text-muted-foreground">Gmail, Drive, and Calendar</p></div></div>
        <p className="text-sm text-muted-foreground">One Google account. Choose which services Paperclip can access.</p>
        {existing && <p className="text-sm">reviewer@example.com · Gmail</p>}
        <Button variant="outline" onClick={() => { setOpen(true); setHandoff(false); }}>{existing ? "Manage services" : "Connect account"}</Button>
      </article>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-(--sz-85vh) flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader className="text-left">
          <div className="flex items-center gap-3"><AppLogo name="Google Workspace" brandKey="google" size={40} /><div className="space-y-1">
            <DialogTitle>{existing ? "Manage Google Workspace services" : "Connect Google Workspace"}</DialogTitle>
            <DialogDescription className={existing ? "" : "sr-only"}>{existing ? "reviewer@example.com" : "Choose the Google services to connect."}</DialogDescription>
          </div></div>
        </DialogHeader>
        {step === "services" ? <><div className="min-h-0 space-y-3 overflow-y-auto">
          <GoogleWorkspaceServiceFields value={selection} onChange={setSelection} />
          {!chosen.length && <p className="text-xs text-muted-foreground" aria-live="polite">Select at least one service to continue.</p>}
          </div><footer className="flex shrink-0 items-center justify-between gap-3 pt-4"><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!chosen.length} onClick={() => setStep("review")}>Continue</Button></footer>
        </> : <>
          <div className="min-h-0 space-y-3 overflow-y-auto">
            <h2 className="text-sm font-semibold">{existing ? "Review your updated access" : "Google will ask for access to"}</h2>
            {chosen.map(service => <div key={service.id} className="flex items-center gap-3"><AppLogo name={service.name} brandKey={service.slug} size={24} /><span className="flex-1 text-sm">{service.name}</span><span className="text-xs text-muted-foreground">{selection[service.id] === "write" ? "Read & write" : "Read only"}</span></div>)}
            <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm">Exact Google permissions ({scopes.length})</summary><div className="space-y-2 pt-3">{warnings.map(service => <p key={service.id} className="text-xs text-muted-foreground">{service.warning}</p>)}</div><ul className="space-y-2 pt-3">{scopes.map(scope => <li key={scope} className="break-all font-mono text-xs text-muted-foreground">{scope}{existing && !previousScopes.includes(scope) && <span className="ml-2 font-sans text-foreground">New</span>}</li>)}</ul></details>
            {existing && <p className="text-xs text-muted-foreground">{added.length ? `${added.length} additional permissions need your consent. Your existing connection stays unchanged until Google confirms access.` : "No additional Google permissions requested. Turning a service off in Paperclip does not revoke permissions already granted to Google."}</p>}
            {failed && <p role="alert" className="text-sm text-destructive">Google sign-in could not start. Your selections are saved in this preview. Try again.</p>}
            {handoff && <div role="status" className="space-y-2 rounded-md bg-muted p-3"><p className="flex items-center gap-2 text-sm font-medium"><Check className="size-4" />{existing && !added.length ? "Service changes previewed" : "Permission request prepared"}</p><p className="text-xs text-muted-foreground">{existing && !added.length ? "Storybook preview only. No saved connection or Google permissions were changed." : "Storybook preview only. In the real flow, Google opens here to confirm this exact permission set. No account was connected."}</p><Button variant="outline" size="sm" onClick={() => { setHandoff(false); setStep("services"); }}>Edit services</Button></div>}
          </div>
          <footer className="flex shrink-0 items-center justify-between gap-3 pt-4"><Button variant="ghost" onClick={() => { setStep("services"); setHandoff(false); setFailed(false); }}><ChevronLeft className="size-4" />Back</Button><Button disabled={handoff || !chosen.length} onClick={() => { if (error && !failed) setFailed(true); else { setHandoff(true); setFailed(false); } }}>{failed ? "Try again" : existing && !added.length ? "Save services" : "Continue with Google"}</Button></footer>
        </>}
      </DialogContent>
    </Dialog>
  </main>;
}
