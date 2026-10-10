import { useEffect, useRef, useState } from "react";
import type { Company, CompanyPortabilityPreviewResult } from "@paperclipai/shared";
import { AlertTriangle, FileUp, Upload } from "lucide-react";
import { GithubIcon } from "../icons/github-icon";
import { ApiError } from "../../api/client";
import {
  companiesApi,
  type CompanyImportJobAccepted,
  type CompanyImportJobStatus,
} from "../../api/companies";
import {
  clearStoredImportJob,
  importJobStorageKey,
  readStoredImportJob,
  waitForNextImportJobPoll,
  writeStoredImportJob,
} from "../../lib/import-job-watch";
import { CHUNKED_IMPORT_THRESHOLD_BYTES } from "../../lib/import-transfer";
import { formatMegabytes } from "../../lib/import-preflight";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/**
 * Onboarding's "bring your organization with you" path.
 *
 * Step 1 of the wizard asks for an organization name and creates an empty one.
 * A customer arriving from another Paperclip instance already has agents,
 * skills, projects, and issues, so this offers the alternative: import a
 * portability package as a new organization and continue onboarding into it.
 *
 * The import itself is the shipped company-portability pipeline
 * (`POST /companies/import` with `target.mode = new_company`), not a second
 * importer. Zip uploads travel as an async server-side job because a package
 * can be far larger than one request; a GitHub URL travels inline because it
 * is a URL and never hits the size ceiling.
 */

type SourceMode = "package" | "github";
type Phase = "idle" | "previewing" | "previewed" | "importing";

/**
 * Session-storage scope for an onboarding import.
 *
 * The import page keys stored jobs by company, because it already has one. There
 * is no company here yet, so the wizard uses a fixed scope. The job id still has
 * to survive a reload: the server finishes the import either way, and without a
 * stored id a second attempt would create a second organization.
 */
const ONBOARDING_IMPORT_SCOPE = "onboarding";
const ONBOARDING_IMPORT_PACKAGE_NAME = "package";

/**
 * Whether this browser session has an onboarding import that never settled.
 *
 * The wizard calls this before it decides which branch of step 1 to open. A
 * reload that lands on "New organization" while the server is still running an
 * import is how one person ends up with two organizations, so the check lives
 * next to the storage key it reads.
 */
export function hasPendingOnboardingImport(): boolean {
  return readStoredImportJob(ONBOARDING_IMPORT_SCOPE) !== null;
}

export interface ImportedOrganization {
  companyId: string;
  issuePrefix: string;
  name: string;
}

interface Props {
  onImported: (imported: ImportedOrganization) => void;
  /**
   * Reports whether a job is in flight, so the wizard can hold its own controls
   * still. Switching away mid-import would leave the job running with nothing
   * watching it, and it would then select the imported organization anyway.
   */
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}

function countFromPreview(preview: CompanyPortabilityPreviewResult | null): {
  agents: number;
  projects: number;
  tasks: number;
} {
  if (!preview) return { agents: 0, projects: 0, tasks: 0 };
  return {
    agents: preview.plan.agentPlans.length,
    projects: preview.plan.projectPlans.length,
    // The wire field is `issuePlans`; user-facing copy says "task" per DESIGN.md.
    tasks: preview.plan.issuePlans.length,
  };
}

/** `1 agent` / `2 agents`, without a stray plural on a count of one. */
function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The async job reports the created company id; the board needs the issue
 * prefix too, so re-read the company once the job settles. A failed read is
 * not fatal — onboarding continues and the company list resolves the prefix.
 */
async function readImportedCompany(companyId: string): Promise<Company | null> {
  try {
    return await companiesApi.get(companyId);
  } catch {
    return null;
  }
}

/**
 * The job a 409 submit response points at, if the error carries one.
 *
 * The import API answers "202 with a job id, or 409 with the job already
 * running for this user". Retrying blindly into the 409 leaves the user with no
 * way forward, because the only offered action is the one that keeps failing.
 */
function runningImportJobFromError(err: unknown): CompanyImportJobAccepted | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body as { job?: { id?: unknown } } | null;
  const jobId = body?.job?.id;
  if (typeof jobId !== "string" || jobId.length === 0) return null;
  return {
    job: { id: jobId, status: "running" },
    statusUrl: `/companies/import/jobs/${jobId}`,
  };
}

/** How many times one status read is retried before the step takes over. */
const STATUS_READ_ATTEMPTS = 3;

/**
 * Why a status read failed, split the way the Import page splits it.
 *
 * The distinction decides whether the step keeps watching the job or reports it
 * as unrecoverable. Parking a *permanent* client error as "still running" would
 * leave a phantom job that re-parks on every mount and can never be cleared,
 * which is worse than saying the job is gone.
 */
type StatusReadFailure =
  /** The server has no record of this job: a restart mid-import, or expiry. */
  | { kind: "gone" }
  /** A client error that will not recover by polling again. */
  | { kind: "unreadable" }
  /** Network blip, rate limit, or 5xx. The job is still running. */
  | { kind: "transient"; error: unknown };

function classifyStatusReadFailure(err: unknown): StatusReadFailure {
  if (err instanceof ApiError && err.status === 404) return { kind: "gone" };
  if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
    return { kind: "unreadable" };
  }
  return { kind: "transient", error: err };
}

/**
 * Read a job's status, retrying a transient failure.
 *
 * A blip between Paperclip and its own job store must not look like a finished
 * import, because the user would then submit the package again. A permanent
 * failure is rethrown immediately: retrying it only delays the honest answer.
 */
async function withStatusRetries(read: () => Promise<CompanyImportJobStatus>): Promise<CompanyImportJobStatus> {
  let lastFailure: StatusReadFailure = { kind: "transient", error: null };
  for (let attempt = 0; attempt < STATUS_READ_ATTEMPTS; attempt += 1) {
    try {
      return await read();
    } catch (err) {
      lastFailure = classifyStatusReadFailure(err);
      if (lastFailure.kind !== "transient") throw lastFailure;
      await waitForNextImportJobPoll();
    }
  }
  throw lastFailure;
}

export function ImportExistingOrganization({ onImported, onBusyChange, disabled }: Props) {
  const [sourceMode, setSourceMode] = useState<SourceMode>("package");
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [githubUrl, setGithubUrl] = useState("");
  const [newCompanyName, setNewCompanyName] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<CompanyPortabilityPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumedJobId, setResumedJobId] = useState<string | null>(null);
  // A job the step is still watching, or could watch again, after a status
  // request failed. While this is set the step must not accept a new import:
  // the server would run a second job and create a second organization.
  const [watchableJob, setWatchableJob] = useState<{ jobId: string; storageKey: string } | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const busy = phase === "previewing" || phase === "importing";
  const counts = countFromPreview(preview);

  // A preview can come back with validation errors, and the import endpoint
  // will reject the same package. Treat those as not-ready rather than letting
  // the user spend an import to find out.
  const previewErrors = preview?.errors ?? [];
  // Size guidance, per source, from what each one actually has to carry:
  //
  // - A GitHub source is a URL. The server fetches only the package's text
  //   files, so it never approaches the inline request ceiling and there is
  //   nothing to predict here.
  // - A local `.zip` is uploaded in one multipart request. Above the chunked
  //   threshold the Import page switches to a chunked transfer that onboarding
  //   does not have, so say so before the upload rather than after.
  const zipTooLargeForChunking =
    sourceMode === "package" && packageFile
      ? packageFile.size > CHUNKED_IMPORT_THRESHOLD_BYTES
      : false;
  const blockedReason = (() => {
    // A job we can still watch owns this step. Offering any other action here
    // is how a second organization gets created.
    if (watchableJob) return null;
    if (!preview) return null;
    if (previewErrors.length > 0) {
      return "This package cannot be imported yet. Fix the problems below, then read it again.";
    }
    if (zipTooLargeForChunking) {
      return `This package is ${formatMegabytes(packageFile!.size)}. Onboarding cannot upload a package that large in one request. Use Settings, then Import, or the CLI.`;
    }
    return null;
  })();
  const readyToApply = phase === "previewed" && blockedReason === null;

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  // Pick up an import that a reload interrupted. The server runs the job to
  // completion regardless, so without this the organization would exist and
  // onboarding would still be asking for a name.
  useEffect(() => {
    const stored = readStoredImportJob(ONBOARDING_IMPORT_SCOPE);
    if (!stored || phase !== "idle") return;
    setResumedJobId(stored.jobId);
    void followJob(stored.jobId, stored.storageKey);
    // Runs once on mount: this is a resume, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function importFields() {
    return {
      include: { company: true, agents: true, projects: true, issues: true },
      target: {
        mode: "new_company" as const,
        newCompanyName: newCompanyName.trim() || null,
      },
      collisionStrategy: "skip" as const,
      // Imported agents and routines land paused, matching the Import page's
      // default. Onboarding has no activation panel, so an agent that starts
      // running the moment it is imported would begin working a task before the
      // operator has seen the board.
      pauseAutomations: true,
    };
  }

  function resetPreview() {
    setPreview(null);
    setPhase("idle");
  }

  function sourceError(): string | null {
    if (sourceMode === "package") {
      return packageFile ? null : "Choose a Paperclip package to import.";
    }
    return githubUrl.trim() ? null : "Enter the GitHub URL of a Paperclip package.";
  }

  /**
   * Poll one import job to its end and hand the created organization over.
   *
   * `storageKey` is the session-storage entry that names this job, so it can be
   * cleared on the way out and so a reload resumes the same job rather than
   * starting another one.
   *
   * A status request that fails is retried rather than treated as a failed
   * import: the job is still running on the server, and reporting it as finished
   * would let the user submit the package again and create a second
   * organization. After the retry budget the job stays stored and the step
   * offers to keep watching that same job.
   */
  async function followJob(initialJobId: string, storageKey: string) {
    setPhase("importing");
    setError(null);
    let jobId = initialJobId;
    try {
      for (;;) {
        let status: CompanyImportJobStatus;
        try {
          status = await withStatusRetries(() => companiesApi.getImportJob(jobId));
        } catch (readFailure) {
          // Only a *transient* failure leaves a job we can still watch. A 404
          // means the server forgot it, and a permanent client error will not
          // recover by polling, so both clear the stored job and report it
          // rather than parking a phantom import the step can never clear.
          const failure = readFailure as { kind: StatusReadFailure["kind"] };
          if (failure.kind === "transient") {
            setWatchableJob({ jobId, storageKey });
            setPhase("idle");
            setError(
              "Paperclip lost contact with the import. It is still running, so this step keeps watching the same import rather than starting a second one.",
            );
            return;
          }
          clearStoredImportJob(storageKey);
          setWatchableJob(null);
          throw new Error(
            failure.kind === "gone"
              ? "The server no longer reports this import. It may have restarted while the import ran."
              : "This import's status can no longer be read. Your session may have expired.",
          );
        }
        if (status.job.status === "succeeded") {
          clearStoredImportJob(storageKey);
          setWatchableJob(null);
          const companyId = status.job.result?.companyId ?? status.job.importResult?.company.id;
          if (!companyId) throw new Error("Import finished without naming the organization.");
          const company = await readImportedCompany(companyId);
          onImported({
            companyId,
            issuePrefix: company?.issuePrefix ?? "",
            name: company?.name ?? status.job.importResult?.company.name ?? "Organization",
          });
          return;
        }
        if (status.job.status === "failed") {
          clearStoredImportJob(storageKey);
          setWatchableJob(null);
          throw new Error(status.job.error?.message ?? "Import failed.");
        }
        jobId = status.job.id;
        await waitForNextImportJobPoll();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
      setPhase("idle");
    }
  }

  async function runPreview() {
    // A job we are still watching owns this instance. Reading another package
    // would tempt a second submit, and a second submit is a second company.
    if (watchableJob) return;
    const missing = sourceError();
    if (missing) {
      setError(missing);
      return;
    }
    setPhase("previewing");
    setError(null);
    try {
      const fields = importFields();
      const result =
        sourceMode === "package"
          ? await companiesApi.importPreviewPackage(packageFile!, fields)
          : await companiesApi.importPreview({
              source: { type: "github", url: githubUrl.trim() },
              ...fields,
            });
      setPreview(result);
      setPhase("previewed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that package.");
      setPhase("idle");
    }
  }

  async function runImport() {
    if (!readyToApply || watchableJob) return;
    setPhase("importing");
    setError(null);
    try {
      const fields = importFields();
      let accepted: CompanyImportJobAccepted;
      try {
        accepted =
          sourceMode === "package"
            ? await companiesApi.importBundlePackageAsync(packageFile!, fields)
            : await companiesApi.importBundleAsync({
                source: { type: "github", url: githubUrl.trim() },
                ...fields,
              });
      } catch (submitError) {
        // A 409 carries the job the server is already running for this user.
        // Adopting it is what keeps a retry from becoming a second company.
        const running = runningImportJobFromError(submitError);
        if (!running) throw submitError;
        accepted = running;
        setError(
          "An import from this session is already running. Following that one instead of starting another.",
        );
      }

      // Store before following, so a reload in the next few seconds still finds
      // the job the server is already running.
      const storageKey = importJobStorageKey(ONBOARDING_IMPORT_SCOPE, ONBOARDING_IMPORT_PACKAGE_NAME);
      writeStoredImportJob(storageKey, { jobId: accepted.job.id, pauseAutomations: true });
      await followJob(accepted.job.id, storageKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
      setPhase("previewed");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label htmlFor="onboarding-import-source">Bring an organization with you</Label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            id="onboarding-import-source"
            aria-pressed={sourceMode === "package"}
            disabled={disabled || busy}
            onClick={() => {
              setSourceMode("package");
              resetPreview();
            }}
            className={cn(
              "flex items-center gap-2 rounded-lg border border-transparent bg-muted px-3 py-(--sz-44px) text-left text-sm transition-colors hover:bg-muted/70 disabled:opacity-60",
              sourceMode === "package" && "ring-2 ring-ring",
            )}
          >
            <Upload className="size-4 shrink-0" />
            <span>From a package</span>
          </button>
          <button
            type="button"
            aria-pressed={sourceMode === "github"}
            disabled={disabled || busy}
            onClick={() => {
              setSourceMode("github");
              resetPreview();
            }}
            className={cn(
              "flex items-center gap-2 rounded-lg border border-transparent bg-muted px-3 py-(--sz-44px) text-left text-sm transition-colors hover:bg-muted/70 disabled:opacity-60",
              sourceMode === "github" && "ring-2 ring-ring",
            )}
          >
            <GithubIcon className="size-4 shrink-0" />
            <span>From GitHub</span>
          </button>
        </div>
      </div>

      {sourceMode === "package" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="onboarding-import-package">Package (.zip)</Label>
          <input
            id="onboarding-import-package"
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            disabled={disabled || busy}
            onChange={(e) => {
              setPackageFile(e.target.files?.[0] ?? null);
              resetPreview();
            }}
            className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-(--sz-32px) file:text-sm"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="onboarding-import-github">GitHub URL</Label>
          <Input
            id="onboarding-import-github"
            className="h-(--sz-44px) rounded-lg border-transparent bg-muted shadow-none dark:bg-muted"
            placeholder="https://github.com/acme/paperclip-company"
            value={githubUrl}
            disabled={disabled || busy}
            onChange={(e) => {
              setGithubUrl(e.target.value);
              resetPreview();
            }}
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="onboarding-import-name">Name (optional)</Label>
        <Input
          id="onboarding-import-name"
          className="h-(--sz-44px) rounded-lg border-transparent bg-muted shadow-none dark:bg-muted"
          placeholder="Use the name inside the package"
          value={newCompanyName}
          disabled={disabled || busy}
          onChange={(e) => setNewCompanyName(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Importing creates a new organization on this instance. Nothing merges into an
          existing one.
        </p>
      </div>

      {resumedJobId ? (
        <p className="text-xs text-muted-foreground">
          An import from this session is still running. Waiting for it to finish.
        </p>
      ) : null}

      {watchableJob ? (
        <div className="flex flex-col gap-2 rounded-lg bg-muted p-3 text-sm">
          <span>A previous import is still running on the server.</span>
          <span className="text-muted-foreground">
            Keep watching that import rather than starting a second one, so this instance does not
            end up with two organizations.
          </span>
          <Button
            type="button"
            variant="secondary"
            className="self-start"
            disabled={busy}
            onClick={() => void followJob(watchableJob.jobId, watchableJob.storageKey)}
          >
            Keep watching
          </Button>
        </div>
      ) : null}

      {preview ? (
        <div className="flex flex-col gap-1 rounded-lg bg-muted p-3 text-sm">
          <span className="font-medium">
            {blockedReason ? "This package is not ready" : "Ready to import"}
          </span>
          <span className="text-muted-foreground">
            {formatCount(counts.agents, "agent")} · {formatCount(counts.projects, "project")} ·{" "}
            {formatCount(counts.tasks, "task")}
          </span>
          {blockedReason ? (
            <span className="text-muted-foreground">{blockedReason}</span>
          ) : null}
          {previewErrors.length > 0 ? (
            <ul className="list-disc pl-5 text-xs text-destructive">
              {previewErrors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        {readyToApply ? (
          <Button type="button" disabled={busy} onClick={() => void runImport()}>
            <FileUp className="size-4" />
            Import organization
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || busy}
            onClick={() => void runPreview()}
          >
            {phase === "previewing" ? "Reading package…" : "Check package"}
          </Button>
        )}
      </div>
    </div>
  );
}