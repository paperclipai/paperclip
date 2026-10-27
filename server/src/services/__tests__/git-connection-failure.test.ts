import { describe, expect, it } from "vitest";
import type { GitConnectionFailure } from "@paperclipai/adapter-utils/connection-failure";
import {
  classifyGitCloneFailure,
  GitConnectionFailureError,
  readGitConnectionFailure,
} from "../git-connection-failure.js";

const httpsRemote = "https://example.test/team/repository.git";
const sshRemote = "git@example.test:team/repository.git";
const authenticationStderr = `fatal: Authentication failed for '${httpsRemote}/'`;

function childFailure(stderr: string, overrides: Record<string, unknown> = {}) {
  return Object.assign(new Error("Git clone subprocess failed"), {
    code: 128,
    stderr,
    signal: null,
    killed: false,
    ...overrides,
  });
}

function classification(reason: GitConnectionFailure["reason"]): GitConnectionFailure {
  return { schemaVersion: 1, provider: "git", operation: "clone", reason };
}

describe("Git clone connection failure classification", () => {
  it.each([
    ["HTTPS authentication", httpsRemote, authenticationStderr, "authentication_failed"],
    ["disabled username prompt", httpsRemote,
      "fatal: could not read Username for 'https://example.test': terminal prompts disabled", "authentication_failed"],
    ["disabled password prompt", httpsRemote,
      "fatal: could not read Password for 'https://git@example.test': terminal prompts disabled", "authentication_failed"],
    ["SSH public key", sshRemote,
      "git@example.test: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.", "authentication_failed"],
    ["private repository", httpsRemote,
      `remote: Repository not found.\nfatal: repository '${httpsRemote}/' not found`, "repository_unavailable"],
    ["HTTP unauthorized", httpsRemote,
      `fatal: unable to access '${httpsRemote}/': The requested URL returned error: 401`, "authentication_failed"],
    ["HTTP forbidden", httpsRemote,
      `fatal: unable to access '${httpsRemote}/': The requested URL returned error: 403`, "authentication_failed"],
    ["HTTP missing repository", httpsRemote,
      `fatal: unable to access '${httpsRemote}/': The requested URL returned error: 404`, "repository_unavailable"],
    ["invalid HTTP port", "https://example.test:invalid/team/repository.git",
      "fatal: unable to access 'https://example.test:invalid/team/repository.git/': Port number was not a decimal number between 0 and 65535", "invalid_remote"],
    ["invalid HTTP URL", "https://example.test:invalid/team/repository.git",
      "fatal: unable to access 'https://example.test:invalid/team/repository.git/': URL rejected: Port number was not a decimal number between 0 and 65535", "invalid_remote"],
    ["SSH alias DNS", "git@repo-alias.example.test:team/repository.git",
      "ssh: Could not resolve hostname repo-alias.example.test: Name or service not known\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.", "dns_failure"],
    ["HTTPS DNS", httpsRemote,
      `fatal: unable to access '${httpsRemote}/': Could not resolve host: example.test`, "dns_failure"],
    ["SSH refusal", sshRemote,
      "ssh: connect to host example.test port 22: Connection refused\nfatal: Could not read from remote repository.", "connection_refused"],
    ["HTTPS refusal", httpsRemote,
      `fatal: unable to access '${httpsRemote}/': Failed to connect to example.test: Connection refused`, "connection_refused"],
    ["SSH unreachable network", "ssh://git@example.test/team/repository.git",
      "ssh: connect to host example.test port 22: Network is unreachable\nfatal: Could not read from remote repository.", "network_unreachable"],
    ["SSH missing route", sshRemote,
      "ssh: connect to host example.test port 22: No route to host\nfatal: Could not read from remote repository.", "network_unreachable"],
    ["HTTPS reset", httpsRemote,
      `fatal: unable to access '${httpsRemote}/': Recv failure: Connection was reset`, "connection_reset"],
    ["SSH reset", sshRemote,
      "Connection reset by example.test port 22\nfatal: Could not read from remote repository.", "connection_reset"],
    ["SSH timeout", sshRemote,
      "ssh: connect to host example.test port 22: Connection timed out\nfatal: Could not read from remote repository.", "connection_timeout"],
    ["HTTPS timeout", httpsRemote,
      `fatal: unable to access '${httpsRemote}/': Operation timed out after 30000 milliseconds with 0 bytes received`, "connection_timeout"],
    ["HTTPS certificate", httpsRemote,
      `fatal: unable to access '${httpsRemote}/': SSL certificate problem: unable to get local issuer certificate`, "tls_failure"],
    ["HTTPS rate limit", httpsRemote,
      `fatal: unable to access '${httpsRemote}/': The requested URL returned error: 429`, "rate_limited"],
    ["HTTPS service unavailable", httpsRemote,
      `fatal: unable to access '${httpsRemote}/': The requested URL returned error: 503`, "remote_unavailable"],
    ["HTTPS bad gateway", httpsRemote,
      `fatal: unable to access '${httpsRemote}/': The requested URL returned error: 502`, "remote_unavailable"],
  ] as const)("classifies the actual remote clone diagnostic: %s", (_name, remote, stderr, reason) => {
    expect(classifyGitCloneFailure(remote, childFailure(`Cloning into 'repository'...\n${stderr}\n`)))
      .toEqual(classification(reason));
  });

  it.each([
    "/tmp/repository", "./repository", "../repository", "repository", "~/repository",
    "C:\\repository", "C:/repository", "file:///tmp/repository", "file://example.test/repository",
    "ftp://example.test/repository", "gopher://example.test/repository", "ext::example.test/repository",
    "https::example.test/repository", "", "example.test/repository",
  ])("keeps local paths and unsupported transports reportable: %s", (remote) => {
    expect(classifyGitCloneFailure(remote, childFailure(authenticationStderr))).toBeNull();
  });

  it.each([
    ["missing Git executable", { code: "ENOENT" }],
    ["string exit code", { code: "128" }],
    ["successful exit", { code: 0 }],
    ["non-fatal exit", { code: 1 }],
    ["command error exit", { code: 2 }],
    ["usage exit", { code: 129 }],
    ["negative exit", { code: -1 }],
    ["fractional exit", { code: 128.5 }],
    ["unknown exit", { code: undefined }],
    ["nonfinite exit", { code: Infinity }],
    ["killed child", { killed: true }],
    ["terminated child", { signal: "SIGTERM" }],
    ["missing stderr", { stderr: undefined }],
    ["buffer stderr", { stderr: Buffer.from(authenticationStderr) }],
    ["object stderr", { stderr: { message: authenticationStderr } }],
  ] as const)("requires unambiguous child-process failure evidence: %s", (_name, overrides) => {
    expect(classifyGitCloneFailure(httpsRemote, childFailure(authenticationStderr, overrides))).toBeNull();
  });

  it.each([
    "fatal: No space left on device",
    "fatal: Read-only file system",
    "fatal: Input/output error",
    "fatal: Too many open files",
    "fatal: Cannot allocate memory",
    "fatal: could not create work tree dir 'repository': Permission denied",
    "fatal: cannot open file 'repository/.git/config': Permission denied",
    "fatal: bad object HEAD",
    "fatal: corrupt loose object",
    "fatal: invalid index",
    "fatal: not a git repository",
    "fatal: detected dubious ownership in repository",
    "fatal: unexpected internal clone failure",
    "error: unrelated local helper failed",
    "warning: unrelated local configuration failure",
  ])("does not hide a mixed local or unknown diagnostic: %s", (otherDiagnostic) => {
    for (const stderr of [
      `${authenticationStderr}\n${otherDiagnostic}`,
      `${otherDiagnostic}\n${authenticationStderr}`,
    ]) {
      expect(classifyGitCloneFailure(httpsRemote, childFailure(stderr))).toBeNull();
    }
  });

  it.each([
    "", "fatal: Could not read from remote repository.",
    "fatal: destination path 'repository' already exists and is not an empty directory.",
    "fatal: unable to access 'https://example.test/team/repository.git/': The requested URL returned error: 418",
    "fatal: invalid object name 'The requested URL returned error: 503'",
    "fatal: cannot open file 'Permission denied (publickey)': Permission denied",
    "error: local helper reported fatal: Authentication failed before crashing",
  ])("does not infer a remote cause from ambiguous stderr: %s", (stderr) => {
    const error = childFailure(stderr);
    error.message = authenticationStderr;
    expect(classifyGitCloneFailure(httpsRemote, error)).toBeNull();
  });

  it("does not classify messages or serialized child-error lookalikes", () => {
    for (const error of [
      authenticationStderr,
      new Error(authenticationStderr),
      { message: authenticationStderr, code: 128, stderr: authenticationStderr },
      null,
    ]) {
      expect(classifyGitCloneFailure(httpsRemote, error)).toBeNull();
    }
  });
});

describe("producer-owned Git connection failure errors", () => {
  it("preserves the existing error message and returns only the bounded classification", () => {
    const diagnostic = classifyGitCloneFailure(httpsRemote, childFailure(authenticationStderr));
    expect(diagnostic).toEqual(classification("authentication_failed"));
    const error = new GitConnectionFailureError("Unable to prepare project repository", diagnostic!);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GitConnectionFailureError");
    expect(error.message).toBe("Unable to prepare project repository");
    expect(readGitConnectionFailure(error)).toEqual(classification("authentication_failed"));
    expect(JSON.stringify(readGitConnectionFailure(error))).not.toContain("example.test");
    expect(error).not.toHaveProperty("connectionFailure");
    expect(error).not.toHaveProperty("stderr");
  });

  it("does not let caller mutations change retained failure evidence", () => {
    const input = classification("authentication_failed");
    const error = new GitConnectionFailureError("Clone failed", input);
    input.reason = "remote_unavailable";
    const firstRead = readGitConnectionFailure(error)!;
    expect(firstRead).toEqual(classification("authentication_failed"));
    firstRead.reason = "dns_failure";
    expect(readGitConnectionFailure(error)).toEqual(classification("authentication_failed"));
    expect(readGitConnectionFailure(error)).not.toBe(firstRead);
  });

  it("rejects spoofed markers, prototype lookalikes, and serialized errors", () => {
    const diagnostic = classification("authentication_failed");
    const real = new GitConnectionFailureError("Clone failed", diagnostic);
    const spoofed = Object.assign(new Error("Clone failed"), {
      name: "GitConnectionFailureError", connectionFailure: diagnostic,
    });
    for (const value of [
      null, "Clone failed", diagnostic, { connectionFailure: diagnostic }, spoofed,
      Object.assign(Object.create(GitConnectionFailureError.prototype), spoofed),
      JSON.parse(JSON.stringify(real)),
      new Error("Wrapper", { cause: real }),
    ]) {
      expect(readGitConnectionFailure(value)).toBeNull();
    }
    expect(readGitConnectionFailure(real)).toEqual(diagnostic);
  });
});
