import type { AdapterModel } from "@/api/agents";
import { ApiError } from "@/api/client";
import type { LocalClaudeConfigReadResult } from "@paperclipai/shared";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * The value that turns the model row from a list into a free-text field.
 */
const IMPORT_MODEL_OTHER = "__other__";

/**
 * Which of the three probe failures this was (PRODUCT #25).
 *
 * The classes are the gateway's answer, so they are read off the status before
 * anything else. The rejected case carries the second half of its own copy —
 * both Claude credential variables authenticate differently, so a gateway that
 * only accepts one of them reads as a rejected key — and the fix is in the file
 * the import just read, which is the only place it can be.
 *
 * A 4xx that is not a gateway answer is the server refusing this import for a
 * reason of its own — an untrusted instance, a caller who is not the operator, an
 * execution environment that cannot reach the gateway — and its message is the
 * better copy. Everything left is the residual class.
 */
export function importFailureMessage(err: unknown): string {
  if (!(err instanceof ApiError)) {
    // The probe runs on the server, so a request that never got an answer was
    // never about the gateway.
    return "Could not reach Paperclip to import this connection. Try again.";
  }
  if (err.status === 401 || err.status === 403) {
    return "The gateway rejected this key. If this machine's Claude settings hold both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN, the wrong variable was imported — fix the settings file and import again.";
  }
  if (err.status === 408 || err.status === 502 || err.status === 503 || err.status === 504) {
    return "Could not reach the gateway. Check the address and try again.";
  }
  if (err.status >= 400 && err.status < 500 && err.message) return err.message;
  return "The gateway returned a response we could not read. Check the address and try again.";
}

/** A labelled row of the import card's summary. */
function ImportSummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-(length:--text-micro) text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/**
 * The import mode's card: what was read, what it will become, and whether to do it.
 *
 * It stays mounted through a failed probe (PRODUCT #25): a retry costs one press,
 * and re-reading the file to get back here would be the long way round. So the
 * probe's error is passed in rather than owned here, and the card is the same
 * card whether the Import press has never happened or has just failed.
 *
 * `Import` is the step's own footer button rather than a second one here — the
 * surface owns that control for every mode, and two ways to submit one card is
 * one too many. `Cancel` is the card's own, and it is the one control that stays
 * live while the probe runs: a probe is a round trip to someone else's gateway
 * with a fifteen-second ceiling on it, the server writes nothing when it fails,
 * and a reader who has changed their mind must not be held on the card for the
 * rest of it (PRODUCT #22, #18).
 *
 * The key is on this card as a variable name and a masked value and nothing else
 * (PRODUCT #17, #41). The card never holds the value — the read did not return
 * it — so there is nothing here to leak.
 */
export function ClaudeConfigImportCard({
  read,
  name,
  model,
  modelEditing,
  modelOptions,
  error,
  onNameChange,
  onModelChange,
  onModelEditingChange,
  onCancel,
}: {
  read: ImportReadState;
  name: string;
  model: string;
  modelEditing: boolean;
  modelOptions: AdapterModel[];
  error: string | null;
  onNameChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onModelEditingChange: (editing: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-xl bg-muted/40 p-4">
      {read.status === "reading" && (
        // `role="status"` rather than a bare paragraph: the read is a wait nobody
        // asked for, and a screen reader has to be told something is happening
        // behind the spinner (PRODUCT #13, #47).
        <p role="status" className="flex min-h-(--sz-108px) items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Reading this machine&rsquo;s Claude config…
        </p>
      )}

      {read.status === "unavailable" && (
        <div className="flex flex-col gap-3">
          <p role="alert" className="text-sm text-destructive">{read.message}</p>
          {read.guidance && (
            <p className="text-(length:--text-micro) leading-relaxed text-muted-foreground">
              {read.guidance}
            </p>
          )}
        </div>
      )}

      {read.status === "ready" && (
        <>
          <ImportSummaryRow label="Gateway">
            {/* Plain, and plainly an address: the operator is being asked to
                confirm where their key is about to be sent, and the protocol is
                part of that answer (PRODUCT #17). */}
            <span className="font-mono text-xs break-all text-foreground">
              {read.result.baseUrl}
            </span>
          </ImportSummaryRow>

          <ImportSummaryRow label="Key">
            <span className="font-mono text-xs text-foreground">
              {read.result.keyVariable} · {read.result.maskedKey}
            </span>
          </ImportSummaryRow>

          <ImportSummaryRow label="Model">
            {modelEditing ? (
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Model"
                  autoFocus
                  value={model}
                  placeholder="Model id"
                  onChange={(event) => onModelChange(event.target.value)}
                  className="h-8 rounded-md border-transparent bg-background text-xs shadow-none"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 shrink-0 px-2 text-xs"
                  onClick={() => onModelEditingChange(false)}
                >
                  Use the list
                </Button>
              </div>
            ) : (
              <Select value={model} onValueChange={(value) => {
                if (value === IMPORT_MODEL_OTHER) {
                  onModelEditingChange(true);
                  return;
                }
                onModelChange(value);
              }}>
                <SelectTrigger aria-label="Model" className="h-8 w-full text-xs">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                  {/* A gateway can serve a model no curated list carries, and the
                      model field here is the same field it is everywhere else —
                      not stricter for having arrived by import (PRODUCT #19). */}
                  <SelectItem value={IMPORT_MODEL_OTHER}>Other…</SelectItem>
                </SelectContent>
              </Select>
            )}
            {read.result.models.alternatives.length > 0 && (
              <span className="text-(length:--text-micro) text-muted-foreground">
                Also configured: {read.result.models.alternatives.join(", ")}
              </span>
            )}
          </ImportSummaryRow>

          <ImportSummaryRow label="Connection name">
            <Input
              aria-label="Connection name"
              // The card is the answer to the mode just chosen, so what it is
              // about to create is the first thing to land on (PRODUCT #48).
              autoFocus
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              className="h-8 rounded-md border-transparent bg-background text-xs shadow-none"
            />
          </ImportSummaryRow>

          {/* A failed probe leaves the card standing with its values, because the
              fix is on the gateway's side and only costs one more press
              (PRODUCT #25). */}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </>
      )}

      {/* While the read is out there is nothing to confirm yet, so the card holds
          no action of its own — the step's Back is the way out of that wait, and
          it is live because the read is nobody's commitment (PRODUCT #13). */}
      {read.status !== "reading" && (
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Where the import mode's read is.
 *
 * `idle` rather than a nullable snapshot, because "nothing read yet" and "read
 * failed" ask different things of the card: the first opens by reading, the
 * second has already been answered and is waiting to be dismissed.
 */
export type ImportReadState =
  | { status: "idle" }
  | { status: "reading" }
  | { status: "ready"; result: Extract<LocalClaudeConfigReadResult, { status: "ok" }> }
  | {
      status: "unavailable";
      message: string;
      /**
       * What to do about it, when there is something specific to do. A refusal
       * from the server carries its own answer, so it arrives without one.
       */
      guidance?: string;
    };
