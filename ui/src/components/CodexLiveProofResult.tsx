import type { CSSProperties } from "react";
import { evaluateCodexLiveProof } from "./codex-live-proof";

export function CodexLiveProofResult({ result }: { result: unknown }) {
  if (result === null || result === undefined) {
    return (
      <div className="rounded-md border border-border bg-muted/20 px-2.5 py-2 text-(length:--text-micro) text-muted-foreground">
        A fresh live reply is required before this Codex agent can be hired.
      </div>
    );
  }

  const proof = evaluateCodexLiveProof(result);
  if (!proof.valid) {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-(length:--text-micro) text-destructive"
      >
        <div className="font-medium">Live reply not verified</div>
        <p className="mt-1">{proof.reason}</p>
        <p className="mt-1 opacity-90">Run the Codex connection test again before continuing.</p>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="status-chip rounded-md border px-2.5 py-2 text-(length:--text-micro)"
      style={{ "--sc": "var(--status-task-done)" } as CSSProperties}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Live reply verified</span>
        <time dateTime={proof.testedAt} className="text-(length:--text-nano) opacity-80">
          {new Date(proof.testedAt).toLocaleString()}
        </time>
      </div>
      <p className="mt-1 font-medium">{proof.detail}</p>
      {proof.warnings.length > 0 && (
        <ul aria-label="Codex connection warnings" className="mt-2 list-disc space-y-1 pl-4">
          {proof.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
