import { useState } from "react";
import { ArrowRight, Check, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SetupWizardFooter, SetupWizardNavigation } from "@/components/SetupWizard";
import avatar from "./ceo-cliptoon.png";

const labels = ["Choose agent", "Create Slack app", "Add credentials", "Verify Slack connection", "Add avatar", "Connect your Slack account", "Try it"];

/** Design preview: the PNG uses the production Cliptoon renderer; wizard state is local. */
export function SlackAvatarStep({ agentName = "CEO", appName = "ceo-paperclip", initialUploaded = false }: {
  agentName?: string;
  appName?: string;
  initialUploaded?: boolean;
}) {
  const [step, setStep] = useState(4);
  const [uploaded, setUploaded] = useState(initialUploaded);
  const [exited, setExited] = useState(false);
  const filename = `${appName.replace(/[^a-zA-Z0-9_-]+/g, "-") || "agent"}-avatar.png`;

  return <div className="min-h-screen bg-background text-foreground">
    <header className="flex items-center gap-3 border-b border-border px-6 py-4 text-sm">
      <span className="text-muted-foreground">Connectors</span>
      <span aria-hidden="true" className="text-muted-foreground">/</span>
      <span>Connect Slack</span>
    </header>
    <div className="flex flex-col md:flex-row">
      <details className="border-b border-border p-4 md:hidden">
        <summary className="cursor-pointer text-sm font-medium">Step {step + 1} of {labels.length} · {labels[step]}</summary>
        <div className="pt-4"><SetupWizardNavigation inline labels={labels} step={step} availableStep={Math.max(4, step)} onSelect={(next) => { setStep(next); setExited(false); }} /></div>
      </details>
      <aside className="hidden shrink-0 border-r border-border p-6 md:block md:w-64">
        <SetupWizardNavigation inline labels={labels} step={step} availableStep={Math.max(4, step)} onSelect={(next) => { setStep(next); setExited(false); }} />
      </aside>
      <main className="min-w-0 flex-1 p-6 md:p-8">
        <div className="max-w-2xl space-y-8">
          {step === 4 && !exited ? <>
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold">Give {agentName} a face in Slack</h1>
                <span className="text-xs text-muted-foreground">Optional</span>
              </div>
              <p className="text-sm text-muted-foreground">Use {agentName}’s avatar so your team recognizes the agent</p>
            </div>

            <section aria-labelledby="download-heading" className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
              <img src={avatar} width={512} height={512} alt={`${agentName}’s Cliptoon avatar`} className="size-40 shrink-0 rounded-lg bg-muted object-contain" />
              <div className="space-y-3">
                <div className="space-y-1">
                  <h2 id="download-heading" className="text-sm font-semibold">1. Download your agent’s avatar</h2>
                  <p className="text-xs text-muted-foreground">PNG · 512 × 512 · Ready for Slack</p>
                </div>
                <Button variant="outline" asChild>
                  <a href={avatar} download={filename}><Download className="size-4" />Download avatar</a>
                </Button>
              </div>
            </section>

            <section aria-labelledby="upload-heading" className="space-y-4">
              <div className="space-y-1">
                <h2 id="upload-heading" className="text-sm font-semibold">2. Upload it in Slack</h2>
                <p className="text-sm text-muted-foreground">You’ll upload the downloaded image directly in Slack’s app settings.</p>
              </div>
              <ol className="list-decimal space-y-3 pl-5 text-sm">
                <li><a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Open Slack app Settings <ExternalLink className="inline size-3" /></a> and choose <strong>{appName}</strong>.</li>
                <li>Choose <strong>Basic Information</strong>, then scroll to <strong>Display Information</strong>.</li>
                <li>Under <strong>App icon &amp; Preview</strong>, click the app icon and upload <span className="break-all font-mono text-xs">{filename}</span>.</li>
                <li>Confirm the crop, then click <strong>Save Changes</strong> in Slack.</li>
              </ol>
            </section>

            {uploaded && <p role="status" className="flex items-center gap-2 rounded-lg bg-(--status-task-done)/10 p-3 text-sm"><Check className="size-4 text-(--status-task-done)" />You marked the avatar as uploaded in Slack.</p>}
            <SetupWizardFooter onSaveExit={() => setExited(true)}>
              <Button variant="ghost" onClick={() => setStep(5)}>Skip for now</Button>
              <Button onClick={() => { setUploaded(true); setStep(5); }}>{uploaded ? "Continue" : "I’ve uploaded the avatar"}<ArrowRight className="size-4" /></Button>
            </SetupWizardFooter>
          </> : <>
            <h1 className="text-xl font-bold">{exited ? "Setup paused" : labels[step]}</h1>
            <p role="status" className="text-sm text-muted-foreground">{exited ? "Preview only: Save & exit would save your place and return to Connectors." : step === 5 ? "Next, link your personal Slack account to Paperclip. This preview stops at the handoff to that step." : "This preview focuses on the new avatar step. Existing setup steps keep their current behavior."}</p>
            <Button variant="outline" onClick={() => { setStep(4); setExited(false); }}>Back to avatar step</Button>
          </>}
        </div>
      </main>
    </div>
  </div>;
}
