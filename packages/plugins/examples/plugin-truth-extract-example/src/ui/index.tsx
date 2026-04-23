import { useEffect, useMemo, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import type {
  PluginPageProps,
  PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

const ACTION_KEYS = {
  createRun: "create-run",
  forgeImport: "forge-import",
  forgeBulkAcceptAtoms: "forge-bulk-accept-atoms",
  forgeAttestAtomReview: "forge-attest-atom-review",
  forgeSynthesizeClaims: "forge-synthesize-claims",
  forgeAttestClaimReview: "forge-attest-claim-review",
  forgeSynthesizeBrief: "forge-synthesize-brief",
  forgeFreezeExport: "forge-freeze-export",
  getReceipt: "get-receipt",
  listRuns: "list-runs",
} as const;

type RunSummary = {
  issueId: string;
  title: string;
  status: string;
  createdAt: string;
  archivalComplete: boolean;
  gateVerdict: string | null;
};

type ReceiptStep = {
  step: number;
  command: string;
  exit_code?: number;
  gate?: string;
  mode?: string;
  operator?: string;
  attested_at?: string;
  started_at?: string;
  completed_at?: string;
  parsed?: Record<string, unknown> | null;
  parse_miss?: true;
  stdout_doc_key?: string;
  note?: string;
};

type Receipt = {
  receipt_version: number;
  skill_version: string;
  forge_path: string | null;
  forge_head_sha_pin: string;
  transcript_doc_key: string;
  ledger_doc_key: string;
  transcript_file_path: string | null;
  ledger_file_path: string | null;
  steps: ReceiptStep[];
  archival_complete: boolean;
  buyer_facing_complete: false;
  buyer_facing_unsupported_reason: string;
};

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function findStepByCommand(
  receipt: Receipt | null,
  command: string,
): ReceiptStep | undefined {
  if (!receipt) return undefined;
  return [...receipt.steps].reverse().find((s) => s.command === command);
}

function hasAttestation(receipt: Receipt | null, gate: string): boolean {
  if (!receipt) return false;
  return receipt.steps.some((s) => s.gate === gate && s.mode === "manual_attestation");
}

function hasAcceptedAtoms(receipt: Receipt | null): boolean {
  if (!receipt) return false;
  const bulk = findStepByCommand(receipt, "truth:bulk-accept-atoms");
  const attested = hasAttestation(receipt, "atom_review");
  return (bulk && bulk.exit_code === 0) || attested;
}

export function TruthExtractPage({ context }: PluginPageProps) {
  const createRun = usePluginAction(ACTION_KEYS.createRun);
  const forgeImport = usePluginAction(ACTION_KEYS.forgeImport);
  const forgeBulkAccept = usePluginAction(ACTION_KEYS.forgeBulkAcceptAtoms);
  const forgeAttestAtoms = usePluginAction(ACTION_KEYS.forgeAttestAtomReview);
  const forgeSynthClaims = usePluginAction(ACTION_KEYS.forgeSynthesizeClaims);
  const forgeAttestClaims = usePluginAction(ACTION_KEYS.forgeAttestClaimReview);
  const forgeSynthBrief = usePluginAction(ACTION_KEYS.forgeSynthesizeBrief);
  const forgeFreeze = usePluginAction(ACTION_KEYS.forgeFreezeExport);
  const getReceipt = usePluginAction(ACTION_KEYS.getReceipt);
  const listRuns = usePluginAction(ACTION_KEYS.listRuns);

  const [transcript, setTranscript] = useState("");
  const [ledger, setLedger] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const [operator, setOperator] = useState("");
  const [stepBusy, setStepBusy] = useState<string | null>(null);

  async function refreshList() {
    try {
      const result = (await listRuns({
        companyId: context.companyId,
        limit: 25,
      })) as RunSummary[];
      setRuns(result);
    } catch (err) {
      setError(formatError(err));
    }
  }

  useEffect(() => {
    void refreshList();
    const interval = setInterval(() => {
      void refreshList();
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.companyId]);

  useEffect(() => {
    if (!selectedIssueId) {
      setReceipt(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const result = (await getReceipt({
          companyId: context.companyId,
          issueId: selectedIssueId,
        })) as Receipt;
        if (!cancelled) setReceipt(result);
      } catch (err) {
        if (!cancelled) setError(formatError(err));
      }
    }
    void load();
    const interval = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIssueId, context.companyId]);

  async function handleCreate() {
    setError(null);
    if (!transcript.trim()) {
      setError("Transcript JSON is required");
      return;
    }
    if (!ledger.trim()) {
      setError("Layer A ledger JSON is required (paperclip-truth-extract output)");
      return;
    }
    setSubmitting(true);
    try {
      const result = (await createRun({
        companyId: context.companyId,
        transcriptJson: transcript,
        ledgerJson: ledger,
        ...(title.trim() ? { title: title.trim() } : {}),
      })) as { issueId: string };
      setSelectedIssueId(result.issueId);
      setTranscript("");
      setLedger("");
      setTitle("");
      await refreshList();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function runStep(
    key: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    setError(null);
    setStepBusy(key);
    try {
      await fn();
      // Refresh receipt immediately.
      if (selectedIssueId) {
        const r = (await getReceipt({
          companyId: context.companyId,
          issueId: selectedIssueId,
        })) as Receipt;
        setReceipt(r);
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStepBusy(null);
    }
  }

  const runId = useMemo<number | null>(() => {
    const s = findStepByCommand(receipt, "truth:import-liberty-ledger");
    if (!s || !s.parsed || typeof s.parsed.run_id !== "number") return null;
    return s.parsed.run_id;
  }, [receipt]);

  const briefId = useMemo<number | null>(() => {
    const s = findStepByCommand(receipt, "truth:synthesize-brief");
    if (!s || !s.parsed || typeof s.parsed.brief_id !== "number") return null;
    return s.parsed.brief_id;
  }, [receipt]);

  const atomsReady = hasAcceptedAtoms(receipt);
  const claimsReady =
    findStepByCommand(receipt, "truth:synthesize-claims")?.exit_code === 0;
  const claimReviewAttested = hasAttestation(receipt, "claim_review");
  const briefReady =
    findStepByCommand(receipt, "truth:synthesize-brief")?.exit_code === 0;

  return (
    <section aria-label="Truth Extract" style={{ display: "grid", gap: "1rem" }}>
      <header>
        <h1>Truth Extract — proposal-forge thin binding</h1>
        <p style={{ color: "#666", margin: 0 }}>
          Paperclip does not re-author truth generation. This plugin invokes
          proposal-forge's <code>truth:*</code> artisan commands via{" "}
          <code>PAPERCLIP_TRUTH_FORGE_PATH</code> and records hashes, run IDs,
          and artifact paths as{" "}
          <code>proposal-forge.receipt.json</code> on the issue.
        </p>
        <p style={{ color: "#999", margin: 0, fontSize: "0.85em" }}>
          Layer A extractor is frozen-v1 (Liberty-validated). Buyer-facing
          completion is unsupported until <code>truth:review-brief</code>{" "}
          exists in proposal-forge.
        </p>
      </header>

      <section aria-label="Start a run">
        <h2>Create run</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
          style={{ display: "grid", gap: "0.5rem" }}
        >
          <label>
            Title (optional)
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Liberty / Mojo Solo — archival v2"
              style={{ width: "100%" }}
            />
          </label>
          <label>
            Transcript (JSON array of utterances)
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder='[{"sentence":"...","startTime":0,"endTime":3.2,"speaker_name":"Andrea Field","speaker_id":"spk_1"}, ...]'
              rows={6}
              style={{ width: "100%", fontFamily: "monospace" }}
            />
          </label>
          <label>
            Layer A ledger (paperclip-truth-extract output, JSON)
            <textarea
              value={ledger}
              onChange={(e) => setLedger(e.target.value)}
              placeholder='{"truth_atoms":[...], "context_atoms":[...], "noise_atoms":[...], "coverage_ledger":[...], ...}'
              rows={10}
              style={{ width: "100%", fontFamily: "monospace" }}
            />
          </label>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create run"}
            </button>
            {error ? (
              <span style={{ color: "#c00" }} role="alert">
                {error}
              </span>
            ) : null}
          </div>
        </form>
      </section>

      <section aria-label="Runs">
        <h2>Runs</h2>
        {runs.length === 0 ? (
          <p style={{ color: "#666" }}>No runs yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0 }}>
            {runs.map((r) => (
              <li
                key={r.issueId}
                style={{
                  padding: "0.5rem",
                  borderBottom: "1px solid #eee",
                  cursor: "pointer",
                  background:
                    selectedIssueId === r.issueId ? "#f6f6f6" : undefined,
                }}
                onClick={() => setSelectedIssueId(r.issueId)}
              >
                <strong>{r.title}</strong>
                <div style={{ fontSize: "0.85em", color: "#666" }}>
                  {r.status} · {r.createdAt} ·{" "}
                  {r.archivalComplete ? "archival ✓" : "in progress"}
                  {r.gateVerdict ? ` · gates ${r.gateVerdict}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {receipt && selectedIssueId ? (
        <section aria-label="Run detail">
          <h2>Forge chain</h2>
          <p style={{ color: "#666", fontSize: "0.85em" }}>
            forge_path: <code>{receipt.forge_path ?? "(not set)"}</code> · pin:{" "}
            <code>{receipt.forge_head_sha_pin}</code> · skill:{" "}
            <code>{receipt.skill_version}</code>
          </p>

          <StepRow
            label="1. truth:import-liberty-ledger"
            done={runId !== null}
            action="Run import"
            busy={stepBusy === "import"}
            disabled={runId !== null}
            onRun={() =>
              runStep("import", () =>
                forgeImport({
                  companyId: context.companyId,
                  issueId: selectedIssueId,
                }),
              )
            }
            detail={
              runId !== null ? `run_id = ${runId}` : "Imports transcript + ledger."
            }
          />

          <StepRow
            label="2a. truth:bulk-accept-atoms (automated)"
            done={!!findStepByCommand(receipt, "truth:bulk-accept-atoms")}
            action="Bulk accept"
            busy={stepBusy === "bulk-accept"}
            disabled={runId === null || atomsReady}
            onRun={() =>
              runStep("bulk-accept", () =>
                forgeBulkAccept({
                  companyId: context.companyId,
                  issueId: selectedIssueId,
                }),
              )
            }
            detail="Weaker provenance. Only run if Layer A audits passed."
          />

          <ManualStep
            label="2b. Atom review (manual — no CLI)"
            done={hasAttestation(receipt, "atom_review")}
            disabled={runId === null || atomsReady}
            instructions={[
              "proposal-forge has no artisan command for manual atom review.",
              `Accept atoms for truth_run #${runId ?? "<id>"} via the proposal-forge UI or by directly updating truth_atoms.status = 'accepted' in the database.`,
              "Then record your attestation below.",
            ]}
            operator={operator}
            setOperator={setOperator}
            busy={stepBusy === "attest-atoms"}
            onAttest={(note) =>
              runStep("attest-atoms", () =>
                forgeAttestAtoms({
                  companyId: context.companyId,
                  issueId: selectedIssueId,
                  operator,
                  ...(note ? { note } : {}),
                }),
              )
            }
          />

          <StepRow
            label="3. truth:synthesize-claims"
            done={claimsReady}
            action="Synthesize claims"
            busy={stepBusy === "synth-claims"}
            disabled={!atomsReady || claimsReady}
            onRun={() =>
              runStep("synth-claims", () =>
                forgeSynthClaims({
                  companyId: context.companyId,
                  issueId: selectedIssueId,
                }),
              )
            }
            detail={
              claimsReady
                ? describeClaims(receipt)
                : "Requires accepted atoms first."
            }
          />

          <ManualStep
            label="4. truth:review-claims (interactive, human)"
            done={claimReviewAttested}
            disabled={!claimsReady || claimReviewAttested}
            instructions={[
              "This artisan command is interactive and cannot be run from a background plugin worker. Run it in your terminal:",
            ]}
            command={`cd "${receipt.forge_path ?? "$PAPERCLIP_TRUTH_FORGE_PATH"}" && php artisan truth:review-claims --run=${runId ?? "<id>"}`}
            operator={operator}
            setOperator={setOperator}
            busy={stepBusy === "attest-claims"}
            onAttest={(note) =>
              runStep("attest-claims", () =>
                forgeAttestClaims({
                  companyId: context.companyId,
                  issueId: selectedIssueId,
                  operator,
                  ...(note ? { note } : {}),
                }),
              )
            }
          />

          <StepRow
            label="5. truth:synthesize-brief"
            done={briefReady}
            action="Synthesize brief"
            busy={stepBusy === "synth-brief"}
            disabled={!claimReviewAttested || briefReady}
            onRun={() =>
              runStep("synth-brief", () =>
                forgeSynthBrief({
                  companyId: context.companyId,
                  issueId: selectedIssueId,
                }),
              )
            }
            detail={
              briefReady
                ? `brief_id = ${briefId} · payload_hash = ${describeBriefHash(receipt)}`
                : "Requires claim review attestation."
            }
          />

          <StepRow
            label="6. truth:freeze-export"
            done={
              findStepByCommand(receipt, "truth:freeze-export")?.exit_code === 0
            }
            action="Freeze export"
            busy={stepBusy === "freeze"}
            disabled={
              !briefReady ||
              findStepByCommand(receipt, "truth:freeze-export")?.exit_code === 0
            }
            onRun={() =>
              runStep("freeze", () =>
                forgeFreeze({
                  companyId: context.companyId,
                  issueId: selectedIssueId,
                }),
              )
            }
            detail={describeFreeze(receipt)}
          />

          <h3>Receipt</h3>
          <pre
            style={{
              background: "#fafafa",
              padding: "0.75rem",
              overflow: "auto",
              maxHeight: "30rem",
              fontSize: "0.8em",
            }}
          >
            {JSON.stringify(receipt, null, 2)}
          </pre>
        </section>
      ) : null}
    </section>
  );
}

function describeClaims(receipt: Receipt): string {
  const s = findStepByCommand(receipt, "truth:synthesize-claims");
  if (!s || !s.parsed) return "done";
  const p = s.parsed as Record<string, unknown>;
  return `synthesis_run=${p.synthesis_run_id} · persisted=${p.claims_persisted} · rejected=${p.claims_rejected}`;
}

function describeBriefHash(receipt: Receipt): string {
  const s = findStepByCommand(receipt, "truth:synthesize-brief");
  if (!s || !s.parsed) return "?";
  const h = (s.parsed as Record<string, unknown>).brief_payload_hash;
  return typeof h === "string" ? h.slice(0, 12) + "…" : "?";
}

function describeFreeze(receipt: Receipt): string {
  const s = findStepByCommand(receipt, "truth:freeze-export");
  if (!s) return "Archival freeze with 6 release gates.";
  if (s.exit_code !== 0) return `exit=${s.exit_code} — check stdout doc`;
  if (!s.parsed) return "parse miss — inspect stdout doc";
  const p = s.parsed as { gate_verdict?: string; exports?: unknown[] };
  const count = Array.isArray(p.exports) ? p.exports.length : 0;
  return `verdict=${p.gate_verdict} · ${count} export(s) frozen`;
}

// --- Reusable step rows --------------------------------------------------

function StepRow(props: {
  label: string;
  done: boolean;
  action: string;
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
  detail: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        gap: "0.5rem",
        alignItems: "center",
        padding: "0.5rem 0",
        borderBottom: "1px solid #f0f0f0",
      }}
    >
      <span style={{ color: props.done ? "#080" : "#999" }}>
        {props.done ? "✓" : "○"}
      </span>
      <div>
        <div>
          <strong>{props.label}</strong>
        </div>
        <div style={{ fontSize: "0.85em", color: "#666" }}>{props.detail}</div>
      </div>
      <button onClick={props.onRun} disabled={props.disabled || props.busy}>
        {props.busy ? "Running…" : props.action}
      </button>
    </div>
  );
}

function ManualStep(props: {
  label: string;
  done: boolean;
  disabled: boolean;
  instructions: string[];
  command?: string;
  operator: string;
  setOperator: (v: string) => void;
  busy: boolean;
  onAttest: (note?: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div
      style={{
        padding: "0.5rem 0",
        borderBottom: "1px solid #f0f0f0",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "0.5rem",
        }}
      >
        <span style={{ color: props.done ? "#080" : "#999" }}>
          {props.done ? "✓" : "○"}
        </span>
        <strong>{props.label}</strong>
      </div>
      {props.instructions.map((line, i) => (
        <div
          key={i}
          style={{ fontSize: "0.85em", color: "#666", marginTop: "0.25rem" }}
        >
          {line}
        </div>
      ))}
      {props.command ? (
        <pre
          style={{
            background: "#f6f6f6",
            padding: "0.5rem",
            fontSize: "0.8em",
            overflow: "auto",
          }}
        >
          {props.command}
        </pre>
      ) : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 2fr auto",
          gap: "0.5rem",
          alignItems: "center",
        }}
      >
        <input
          type="text"
          placeholder="operator (email/handle)"
          value={props.operator}
          onChange={(e) => props.setOperator(e.target.value)}
          disabled={props.disabled}
        />
        <input
          type="text"
          placeholder="note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={props.disabled}
        />
        <button
          onClick={() => props.onAttest(note || undefined)}
          disabled={
            props.disabled || props.busy || props.operator.trim().length === 0
          }
        >
          {props.busy ? "Recording…" : "Record attestation"}
        </button>
      </div>
    </div>
  );
}

export function TruthExtractWidget({ context }: PluginWidgetProps) {
  const listRuns = usePluginAction(ACTION_KEYS.listRuns);
  const [count, setCount] = useState<number | null>(null);
  const [archived, setArchived] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = (await listRuns({
          companyId: context.companyId,
          limit: 25,
        })) as RunSummary[];
        if (!cancelled) {
          setCount(result.length);
          setArchived(result.filter((r) => r.archivalComplete).length);
        }
      } catch (err) {
        if (!cancelled) setError(formatError(err));
      }
    }
    void load();
    const interval = setInterval(() => {
      void load();
    }, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.companyId]);

  return (
    <section aria-label="Truth Extract status">
      <strong>Truth Extract — forge binding</strong>
      {error ? (
        <div style={{ color: "#c00" }}>{error}</div>
      ) : (
        <div>
          {count === null ? "…" : `${count} run${count === 1 ? "" : "s"}`}
          {archived !== null ? ` · ${archived} archived` : ""}
        </div>
      )}
      <div style={{ fontSize: "0.8em", color: "#666" }}>
        Company: {context.companyId}
      </div>
    </section>
  );
}
