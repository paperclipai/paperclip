function shQuote(segment: string): string {
  return `'${segment.replace(/'/g, "'\\''")}'`;
}

export const SANDBOX_REPOSITORY_WORKSPACE = "/workspace/repository";
const APPROVED_GIT_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

export interface SandboxRepositoryRequest {
  repoUrl: string;
  revisionSha: string;
  workspacePath?: string;
  /** Explicitly set when the source cannot be cloned anonymously. */
  credentialRequired?: boolean;
  /** Presence of the configured minimal read-only Secret binding. */
  credentialSecretName?: string | null;
}

export interface SandboxRepositoryExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxRepositorySnapshot {
  workspacePath: string;
  repoUrl: string;
  revisionSha: string;
  headSha: string;
  clean: true;
  strategy: "sandbox_repository";
}

function sanitizeRepoUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[redacted]";
  }
}

function validateRepoUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Sandbox repository realization requires a valid approved HTTPS Git URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !APPROVED_GIT_HOSTS.has(url.hostname.toLowerCase()) ||
    url.pathname.split("/").filter(Boolean).length < 2
  ) {
    throw new Error("Sandbox repository realization requires an approved HTTPS Git URL without credentials, query, or fragment.");
  }
  return sanitizeRepoUrl(url.toString());
}

function validateWorkspacePath(value: string | undefined): string {
  const workspacePath = value?.trim() || SANDBOX_REPOSITORY_WORKSPACE;
  if (workspacePath !== SANDBOX_REPOSITORY_WORKSPACE) {
    throw new Error("Sandbox repository realization only permits the fixed /workspace/repository target.");
  }
  return SANDBOX_REPOSITORY_WORKSPACE;
}

export function validateSandboxRepositoryRequest(input: Partial<SandboxRepositoryRequest>): SandboxRepositoryRequest {
  const repoUrl = typeof input.repoUrl === "string" ? input.repoUrl.trim() : "";
  const revisionSha = typeof input.revisionSha === "string" ? input.revisionSha.trim() : "";
  if (!repoUrl) throw new Error("Sandbox repository realization requires repoUrl.");
  if (!/^[0-9a-f]{40}$/i.test(revisionSha)) {
    throw new Error("Sandbox repository realization requires an exact 40-character revision SHA.");
  }
  const credentialRequired = input.credentialRequired === true;
  if (credentialRequired && !input.credentialSecretName?.trim()) {
    throw new Error("Sandbox repository realization requires an explicit read-only Git credential binding.");
  }
  return {
    repoUrl: validateRepoUrl(repoUrl),
    revisionSha: revisionSha.toLowerCase(),
    workspacePath: validateWorkspacePath(input.workspacePath),
    credentialRequired,
    credentialSecretName: input.credentialSecretName?.trim() || null,
  };
}

export async function realizeSandboxRepository(input: {
  request: SandboxRepositoryRequest;
  execute: (command: string[]) => Promise<SandboxRepositoryExecutionResult>;
}): Promise<SandboxRepositorySnapshot> {
  const request = validateSandboxRepositoryRequest(input.request);
  const workspacePath = request.workspacePath!;
  const run = async (script: string) => {
    const result = await input.execute(["/bin/sh", "-lc", script]);
    if (result.exitCode !== 0) {
      throw new Error("Sandbox repository realization failed during Git preparation; repository credentials and Git output were suppressed.");
    }
    return result;
  };

  const credentialSetup = request.credentialRequired
    ? `printf '%s\\n' '#!/bin/sh' 'case "$1" in *Username*) printf "%s" "$GIT_USERNAME" ;; *) printf "%s" "$GIT_TOKEN" ;; esac' > /home/loader/git-askpass && ` +
      `chmod 700 /home/loader/git-askpass && export GIT_ASKPASS=/home/loader/git-askpass; `
    : "";
  await run(
    `mkdir -p /home/loader/tmp /home/loader/.config && ` +
      credentialSetup +
      `export GIT_TERMINAL_PROMPT=0; ` +
    `mkdir -p ${shQuote(workspacePath)} && find ${shQuote(workspacePath)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && ` +
      `git clone --no-checkout -- ${shQuote(request.repoUrl)} ${shQuote(workspacePath)} && ` +
      `git -C ${shQuote(workspacePath)} fetch --no-tags origin ${shQuote(request.revisionSha)} && ` +
      `git -C ${shQuote(workspacePath)} checkout --detach ${shQuote(request.revisionSha)}`,
  );

  const verification = await run(
    `printf 'PAPERCLIP_HEAD=%s\\n' "$(git -C ${shQuote(workspacePath)} rev-parse HEAD)" && ` +
      `printf 'PAPERCLIP_STATUS_BEGIN\\n' && git -C ${shQuote(workspacePath)} status --porcelain && ` +
      `printf 'PAPERCLIP_STATUS_END\\n'`,
  );
  const head = verification.stdout.match(/(?:^|\n)PAPERCLIP_HEAD=([0-9a-f]{40})(?:\n|$)/i)?.[1]?.toLowerCase();
  const status = verification.stdout.match(/PAPERCLIP_STATUS_BEGIN\n([\s\S]*?)PAPERCLIP_STATUS_END/)?.[1] ?? "";
  if (head !== request.revisionSha) {
    throw new Error("Sandbox repository HEAD did not match the requested revision.");
  }
  if (status.trim().length > 0) {
    throw new Error("Sandbox repository checkout is not clean after detached checkout.");
  }

  return {
    workspacePath,
    repoUrl: sanitizeRepoUrl(request.repoUrl),
    revisionSha: request.revisionSha,
    headSha: head,
    clean: true,
    strategy: "sandbox_repository",
  };
}
