import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../middleware/logger.js";

/**
 * macOS finds the user's keychain through $HOME (the keychain search list and
 * default keychain live under ~/Library). A managed AI home replaces HOME for
 * the run, so any tool that the agent starts and that writes to the keychain
 * (headless Chrome, git's osxkeychain helper, the Claude CLI) finds no
 * keychain. macOS then shows a modal "Keychain Not Found" dialog for each
 * write, on the operator's screen.
 *
 * These helpers give each managed home its own empty, unlocked keychain, so
 * those writes land there without a dialog. The keychain is local to the run:
 * it is never added to the operator's search list, and it goes away with the
 * home. The operator's login keychain stays unreachable from the run.
 */

export const MANAGED_HOME_KEYCHAIN_NAME = "paperclip-agent.keychain-db";

const SECURITY_BIN = "/usr/bin/security";
const SECURITY_TIMEOUT_MS = 10_000;

export type SecurityCommandRunner = (
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<void>;

const execFileAsync = promisify(execFile);

const runSecurity: SecurityCommandRunner = async (args, env) => {
  await execFileAsync(SECURITY_BIN, args, { env, timeout: SECURITY_TIMEOUT_MS });
};

export type KeychainSetupFailureLogger = (
  details: { err: unknown; step: string },
  message: string,
) => void;

type KeychainOptions = {
  platform?: NodeJS.Platform;
  run?: SecurityCommandRunner;
  warn?: KeychainSetupFailureLogger;
};

const warnKeychainSetupFailure: KeychainSetupFailureLogger = (details, message) =>
  logger.warn(details, message);

export function managedHomeKeychainPath(home: string): string {
  return path.join(home, "Library", "Keychains", MANAGED_HOME_KEYCHAIN_NAME);
}

/**
 * Creates the per-run keychain and makes it the only keychain for `HOME=home`.
 * Best effort: a failure never fails the run. Without the keychain, the run
 * still works, and keychain writes behave as they did before this change.
 * Returns true when the keychain is ready.
 */
export async function provisionManagedHomeKeychain(
  home: string,
  options: KeychainOptions = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const run = options.run ?? runSecurity;
  const keychain = managedHomeKeychainPath(home);
  // Only HOME changes. The keychain has no password, so no secret goes on
  // a command line.
  const env = { ...process.env, HOME: home };
  let step = "mkdir";
  try {
    await mkdir(path.dirname(keychain), { recursive: true, mode: 0o700 });
    await mkdir(path.join(home, "Library", "Preferences"), {
      recursive: true,
      mode: 0o700,
    });
    for (const args of [
      ["create-keychain", "-p", "", keychain],
      // No auto-lock, so long runs do not hit a locked keychain.
      ["set-keychain-settings", keychain],
      ["unlock-keychain", "-p", "", keychain],
      // With HOME=home, these write to home/Library/Preferences, not to the
      // operator's preferences.
      ["list-keychains", "-d", "user", "-s", keychain],
      ["default-keychain", "-d", "user", "-s", keychain],
    ]) {
      step = args[0]!;
      await run(args, env);
    }
    return true;
  } catch (err) {
    // Still best effort, but say why the macOS dialog can come back.
    (options.warn ?? warnKeychainSetupFailure)(
      { err, step },
      "Managed AI home keychain setup failed; keychain writes in this run may show a macOS dialog",
    );
    return false;
  }
}

/**
 * Deletes the per-run keychain before the home is removed, so securityd does
 * not keep a reference to a missing file. Best effort.
 */
export async function releaseManagedHomeKeychain(
  home: string,
  options: KeychainOptions = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== "darwin") return;
  const run = options.run ?? runSecurity;
  try {
    await run(["delete-keychain", managedHomeKeychainPath(home)], {
      ...process.env,
      HOME: home,
    });
  } catch {
    // The home is removed next. A missing keychain is not an error.
  }
}
