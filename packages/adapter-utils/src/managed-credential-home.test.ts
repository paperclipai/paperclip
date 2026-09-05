import { promises as fsPromises } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertManagedCredentialHome,
  assertNoSymlinkInManagedCredentialPath,
} from "./managed-credential-home.js";

describe("assertManagedCredentialHome", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function setUpInstance() {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-managed-credential-home-"));
    cleanupDirs.push(homeDir);
    const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: homeDir, PAPERCLIP_INSTANCE_ID: "default" };
    const instanceRoot = path.join(homeDir, "instances", "default");
    const companyId = "company-a";
    const companyRoot = path.join(instanceRoot, "companies", companyId);
    await mkdir(companyRoot, { recursive: true });
    return { env, companyId, companyRoot, instanceRoot };
  }

  /** Same as {@link setUpInstance}, but leaves the company directory itself unmade, so a test can put a symbolic link there instead. */
  async function setUpInstanceWithoutCompanyDir() {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-managed-credential-home-"));
    cleanupDirs.push(homeDir);
    const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: homeDir, PAPERCLIP_INSTANCE_ID: "default" };
    const instanceRoot = path.join(homeDir, "instances", "default");
    const companiesRoot = path.join(instanceRoot, "companies");
    await mkdir(companiesRoot, { recursive: true });
    return { env, instanceRoot, companiesRoot };
  }

  it("accepts the company default home", async () => {
    const { env, companyId, companyRoot } = await setUpInstance();
    const candidateDir = path.join(companyRoot, "codex-home");
    await mkdir(candidateDir, { recursive: true });

    const resolved = await assertManagedCredentialHome({ env, companyId, candidateDir });

    expect(resolved).toBe(candidateDir);
  });

  it("accepts an account home under the company root", async () => {
    const { env, companyId, companyRoot } = await setUpInstance();
    const candidateDir = path.join(companyRoot, "codex-auth-cache", "some-handle");
    await mkdir(candidateDir, { recursive: true });

    const resolved = await assertManagedCredentialHome({ env, companyId, candidateDir });

    expect(resolved).toBe(candidateDir);
  });

  it("rejects a path outside the instance root", async () => {
    const { env, companyId } = await setUpInstance();
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-outside-"));
    cleanupDirs.push(outsideDir);

    await expect(
      assertManagedCredentialHome({ env, companyId, candidateDir: outsideDir }),
    ).rejects.toThrow("outside the company-managed directory tree");
  });

  it("rejects a path under another company", async () => {
    const { env, companyId, instanceRoot } = await setUpInstance();
    const otherCompanyDir = path.join(instanceRoot, "companies", "company-b", "codex-home");
    await mkdir(otherCompanyDir, { recursive: true });

    await expect(
      assertManagedCredentialHome({ env, companyId, candidateDir: otherCompanyDir }),
    ).rejects.toThrow("outside the company-managed directory tree");
  });

  it("rejects a symbolic link inside the company root that points outside it", async () => {
    const { env, companyId, companyRoot } = await setUpInstance();
    const outsideTarget = await mkdtemp(path.join(os.tmpdir(), "paperclip-symlink-target-"));
    cleanupDirs.push(outsideTarget);
    const linkPath = path.join(companyRoot, "codex-home");
    await symlink(outsideTarget, linkPath, "dir");

    await expect(
      assertManagedCredentialHome({ env, companyId, candidateDir: linkPath }),
    ).rejects.toThrow("outside the company-managed directory tree");
  });

  it("rejects a relative path that escapes with \"..\"", async () => {
    const { env, companyId, companyRoot } = await setUpInstance();
    const escapingPath = path.join(companyRoot, "..", "..", "escaped");

    await expect(
      assertManagedCredentialHome({ env, companyId, candidateDir: escapingPath }),
    ).rejects.toThrow("outside the company-managed directory tree");
  });

  it("accepts a candidate directory that does not exist yet", async () => {
    const { env, companyId, companyRoot } = await setUpInstance();
    const candidateDir = path.join(companyRoot, "codex-auth-cache", "not-created-yet");

    const resolved = await assertManagedCredentialHome({ env, companyId, candidateDir });

    expect(resolved).toBe(candidateDir);
  });

  it("names no path and no identifier in its rejection message", async () => {
    const { env, companyId } = await setUpInstance();
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-outside-"));
    cleanupDirs.push(outsideDir);

    await expect(
      assertManagedCredentialHome({ env, companyId, candidateDir: outsideDir }),
    ).rejects.toThrow(/^The credential home is outside the company-managed directory tree\.$/);
  });

  it("rejects a company-root symbolic link that points at another company's directory", async () => {
    const { env, companiesRoot } = await setUpInstanceWithoutCompanyDir();
    const companyId = "company-a";
    const otherCompanyDir = path.join(companiesRoot, "company-b");
    await mkdir(otherCompanyDir, { recursive: true });
    const companyLinkPath = path.join(companiesRoot, companyId);
    await symlink(otherCompanyDir, companyLinkPath, "dir");

    await expect(
      assertManagedCredentialHome({
        env,
        companyId,
        candidateDir: path.join(companyLinkPath, "codex-home"),
      }),
    ).rejects.toThrow("outside the company-managed directory tree");
  });

  it("rejects a company-root symbolic link that points outside the instance tree", async () => {
    const { env, companiesRoot } = await setUpInstanceWithoutCompanyDir();
    const companyId = "company-a";
    const outsideTarget = await mkdtemp(path.join(os.tmpdir(), "paperclip-outside-company-root-"));
    cleanupDirs.push(outsideTarget);
    const companyLinkPath = path.join(companiesRoot, companyId);
    await symlink(outsideTarget, companyLinkPath, "dir");

    await expect(
      assertManagedCredentialHome({
        env,
        companyId,
        candidateDir: path.join(companyLinkPath, "codex-home"),
      }),
    ).rejects.toThrow("outside the company-managed directory tree");
  });

  it("rejects a companies directory that is itself a symbolic link to an external location", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-managed-credential-home-"));
    cleanupDirs.push(homeDir);
    const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: homeDir, PAPERCLIP_INSTANCE_ID: "default" };
    const instanceRoot = path.join(homeDir, "instances", "default");
    await mkdir(instanceRoot, { recursive: true });
    const externalCompaniesTarget = await mkdtemp(
      path.join(os.tmpdir(), "paperclip-external-companies-"),
    );
    cleanupDirs.push(externalCompaniesTarget);
    const companyId = "company-a";
    await mkdir(path.join(externalCompaniesTarget, companyId), { recursive: true });
    await symlink(externalCompaniesTarget, path.join(instanceRoot, "companies"), "dir");

    await expect(
      assertManagedCredentialHome({
        env,
        companyId,
        candidateDir: path.join(externalCompaniesTarget, companyId, "codex-home"),
      }),
    ).rejects.toThrow("outside the company-managed directory tree");
  });

  it("rejects an instance root reached through a symbolic-link ancestor", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-managed-credential-home-"));
    cleanupDirs.push(homeDir);
    const externalInstancesTarget = await mkdtemp(
      path.join(os.tmpdir(), "paperclip-external-instances-"),
    );
    cleanupDirs.push(externalInstancesTarget);
    const companyId = "company-a";
    const externalInstanceRoot = path.join(externalInstancesTarget, "default");
    const externalCompanyDir = path.join(externalInstanceRoot, "companies", companyId);
    await mkdir(externalCompanyDir, { recursive: true });
    // `PAPERCLIP_HOME/instances` is a symbolic link to an external directory.
    // Both the instance root and the `companies` directory resolve through
    // this SAME redirect, so a check that only compares the two resolved
    // paths against each other would still pass.
    await symlink(externalInstancesTarget, path.join(homeDir, "instances"), "dir");
    const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: homeDir, PAPERCLIP_INSTANCE_ID: "default" };

    await expect(
      assertManagedCredentialHome({
        env,
        companyId,
        candidateDir: path.join(externalCompanyDir, "codex-home"),
      }),
    ).rejects.toThrow("outside the company-managed directory tree");
  });

  it("rejects a candidate symlink to another account home inside the same company", async () => {
    const { env, companyId, companyRoot } = await setUpInstance();
    const realAccountHome = path.join(companyRoot, "codex-homes", "account-b");
    await mkdir(realAccountHome, { recursive: true });
    const candidateDir = path.join(companyRoot, "codex-homes", "account-a");
    await mkdir(path.dirname(candidateDir), { recursive: true });
    await symlink(realAccountHome, candidateDir, "dir");

    // Even though the symlink target is still inside the company tree — so
    // the old resolved-path containment check alone would have accepted it —
    // the literal candidate itself is a symbolic link and must be rejected.
    await expect(
      assertManagedCredentialHome({ env, companyId, candidateDir }),
    ).rejects.toThrow("outside the company-managed directory tree");
  });

  it("rejects a symbolic-link swap made after the check, so no token file lands at the swapped-to target", async () => {
    const { env, companyId, companyRoot } = await setUpInstance();
    const candidateDir = path.join(companyRoot, "codex-home");
    await mkdir(candidateDir, { recursive: true });

    const resolved = await assertManagedCredentialHome({ env, companyId, candidateDir });
    expect(resolved).toBe(candidateDir);

    // An attacker swaps the checked directory for a symbolic link to an
    // external target between the check above and a caller's write below.
    const externalTarget = await mkdtemp(path.join(os.tmpdir(), "paperclip-swap-target-"));
    cleanupDirs.push(externalTarget);
    await rm(candidateDir, { recursive: true, force: true });
    await symlink(externalTarget, candidateDir, "dir");

    // A caller must re-verify with a no-follow check immediately before it
    // writes. This simulates that contract: the token write only runs when
    // the re-check passes.
    async function writeTokenIfStillContained(): Promise<void> {
      await assertNoSymlinkInManagedCredentialPath(companyRoot, resolved);
      await writeFile(path.join(resolved, "auth.json"), "token-bytes");
    }

    await expect(writeTokenIfStillContained()).rejects.toThrow(
      "outside the company-managed directory tree",
    );
    expect(await readdir(externalTarget)).toEqual([]);
  });
});

// On a case-insensitive filesystem (the default on macOS and Windows),
// `fs.realpath` can return the on-disk spelling of a directory whose
// configured casing (from `PAPERCLIP_HOME`) differs only by letter case. This
// suite stubs `realpath` to reproduce that exact scenario against a real temp
// directory tree — the test filesystem itself is case-sensitive, so a
// genuine case-insensitive `realpath` behavior has to be simulated — to prove
// a same-location casing difference no longer rejects a valid managed home,
// while containment and symlink rejection still hold. `process.platform` is
// still forced to a non-Linux value in each test as a reminder that the
// guard's behavior must not depend on the host platform; the guard checks
// on-disk directory entries instead, so the forced value does not change the
// outcome.
describe("assertManagedCredentialHome on a case-insensitive filesystem", () => {
  const cleanupDirs: string[] = [];
  const originalPlatform = process.platform;

  afterEach(async () => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("accepts a managed home when PAPERCLIP_HOME's casing differs from fs.realpath's on-disk spelling", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });

    const realHomeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-managed-credential-home-casing-"));
    cleanupDirs.push(realHomeDir);
    const companyId = "company-a";
    const companyRoot = path.join(realHomeDir, "instances", "default", "companies", companyId);
    await mkdir(companyRoot, { recursive: true });
    const candidateDir = path.join(companyRoot, "codex-home");
    await mkdir(candidateDir, { recursive: true });

    // `PAPERCLIP_HOME` is configured with different letter casing than the
    // directory actually created above (same length, same characters, only
    // upper-cased). Stub `fs.realpath` so every path under the
    // differently-cased `configuredHomeDir` resolves to its real, on-disk
    // -cased counterpart under `realHomeDir` — reproducing what a genuine
    // case-insensitive filesystem's `fs.realpath` returns, without needing
    // one for this test run.
    const configuredHomeDir = realHomeDir.toUpperCase();
    const realRealpath = fsPromises.realpath.bind(fsPromises);
    vi.spyOn(fsPromises, "realpath").mockImplementation(async (input, ...rest) => {
      if (typeof input === "string" && input.startsWith(configuredHomeDir)) {
        return realRealpath(realHomeDir + input.slice(configuredHomeDir.length), ...(rest as []));
      }
      return realRealpath(input, ...(rest as []));
    });

    const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: configuredHomeDir, PAPERCLIP_INSTANCE_ID: "default" };
    const configuredCandidateDir = path.join(
      configuredHomeDir,
      "instances",
      "default",
      "companies",
      companyId,
      "codex-home",
    );

    const resolved = await assertManagedCredentialHome({ env, companyId, candidateDir: configuredCandidateDir });

    expect(resolved).toBe(candidateDir);
  });

  async function setUpNonLinuxInstance() {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-managed-credential-home-nonlinux-"));
    cleanupDirs.push(homeDir);
    const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: homeDir, PAPERCLIP_INSTANCE_ID: "default" };
    const companyId = "company-a";
    const companyRoot = path.join(homeDir, "instances", "default", "companies", companyId);
    await mkdir(companyRoot, { recursive: true });
    return { env, companyId, companyRoot };
  }

  it("still rejects a genuine redirect to a different location, not just a casing difference", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { env, companyId } = await setUpNonLinuxInstance();
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-outside-nonlinux-"));
    cleanupDirs.push(outsideDir);

    await expect(
      assertManagedCredentialHome({ env, companyId, candidateDir: outsideDir }),
    ).rejects.toThrow("outside the company-managed directory tree");
  });

  it("still rejects a symbolic link on a non-Linux platform", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { env, companyId, companyRoot } = await setUpNonLinuxInstance();
    const outsideTarget = await mkdtemp(path.join(os.tmpdir(), "paperclip-symlink-target-nonlinux-"));
    cleanupDirs.push(outsideTarget);
    const linkPath = path.join(companyRoot, "codex-home");
    await symlink(outsideTarget, linkPath, "dir");

    await expect(
      assertManagedCredentialHome({ env, companyId, candidateDir: linkPath }),
    ).rejects.toThrow("outside the company-managed directory tree");
  });

  it("rejects a same-cased-looking symbolic link that actually redirects to a colliding, differently-cased directory", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const homeDir = await mkdtemp(
      path.join(os.tmpdir(), "paperclip-managed-credential-home-casecollision-"),
    );
    cleanupDirs.push(homeDir);
    const companyId = "company-a";

    // A directory named "INSTANCES" — a sibling of the literal "instances"
    // name, differing only by letter case. On a case-sensitive filesystem,
    // this is a distinct, attacker-controlled directory, not the same entry
    // a case-insensitive filesystem would report for either spelling.
    const attackerInstancesDir = path.join(homeDir, "INSTANCES");
    const attackerCompanyDir = path.join(attackerInstancesDir, "default", "companies", companyId);
    await mkdir(attackerCompanyDir, { recursive: true });

    // The literal "instances" path is a symbolic link to that colliding
    // sibling. `fs.realpath` on the literal instance root then returns a
    // path that differs from it only by the letter case of this one
    // segment — the exact shape a genuine case-insensitive filesystem also
    // produces, but here it is a real redirect to a different directory.
    await symlink(attackerInstancesDir, path.join(homeDir, "instances"), "dir");
    const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: homeDir, PAPERCLIP_INSTANCE_ID: "default" };

    // Build the candidate the same way an honest caller would: from the
    // literal, lowercase "instances" spelling, not from the attacker's
    // directory directly. This is what makes the redirect dangerous — the
    // literal candidate reaches the attacker's tree only because the
    // instance-root check above adopted it as the boundary.
    const literalCandidateDir = path.join(
      homeDir,
      "instances",
      "default",
      "companies",
      companyId,
      "codex-home",
    );

    await expect(
      assertManagedCredentialHome({ env, companyId, candidateDir: literalCandidateDir }),
    ).rejects.toThrow("outside the company-managed directory tree");
  });
});
