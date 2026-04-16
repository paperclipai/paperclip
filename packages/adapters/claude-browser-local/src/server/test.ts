import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import net from "node:net";

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

async function dirReadable(dirPath: string): Promise<boolean> {
  try {
    await fs.access(dirPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function dirWritable(dirPath: string): Promise<boolean> {
  try {
    await fs.access(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function socketReachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 2_000);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = ctx.config as Record<string, unknown>;

  // --- Profile directory -------------------------------------------------------
  const profileDir =
    typeof config.profileDir === "string"
      ? config.profileDir
      : "/var/lib/surfer/profile";

  if (await dirReadable(profileDir)) {
    if (await dirWritable(profileDir)) {
      checks.push({
        code: "profile_dir_ok",
        level: "info",
        message: `Profile directory is readable and writable: ${profileDir}`,
      });
    } else {
      checks.push({
        code: "profile_dir_not_writable",
        level: "error",
        message: `Profile directory is not writable: ${profileDir}`,
        hint: `Run: sudo mkdir -p "${profileDir}" && sudo chown $(whoami) "${profileDir}"`,
      });
    }
  } else {
    checks.push({
      code: "profile_dir_missing",
      level: "warn",
      message: `Profile directory does not exist yet: ${profileDir}`,
      detail: "It will be created on first sidecar start.",
    });
  }

  // --- Unix socket -------------------------------------------------------------
  const socketPath =
    typeof config.sidecarSocketPath === "string"
      ? config.sidecarSocketPath
      : "/var/run/paperclip/surfer.sock";

  const sidecarRunning = await socketReachable(socketPath);
  checks.push({
    code: sidecarRunning ? "sidecar_running" : "sidecar_not_running",
    level: sidecarRunning ? "info" : "warn",
    message: sidecarRunning
      ? `Playwright sidecar is responding on ${socketPath}`
      : `Playwright sidecar is not running (socket: ${socketPath})`,
    detail: sidecarRunning
      ? undefined
      : "The sidecar will be spawned automatically on the first execute() call.",
  });

  // --- IMAP credentials --------------------------------------------------------
  const imapHost = process.env["SURFER_IMAP_HOST"] ?? "";
  const imapUser = process.env["SURFER_IMAP_USER"] ?? "";
  const imapPass = process.env["SURFER_IMAP_PASS"] ?? "";

  if (imapHost && imapUser && imapPass) {
    checks.push({
      code: "imap_configured",
      level: "info",
      message: `IMAP configured for ${imapUser} @ ${imapHost}`,
    });
  } else {
    checks.push({
      code: "imap_not_configured",
      level: "warn",
      message: "IMAP credentials not set (SURFER_IMAP_HOST/USER/PASS)",
      detail: "read_inbox tool will fail until these are set.",
      hint: "Set SURFER_IMAP_HOST, SURFER_IMAP_USER, SURFER_IMAP_PASS in the sidecar environment.",
    });
  }

  // --- Captcha API key ---------------------------------------------------------
  const captchaKey = process.env["SURFER_CAPTCHA_API_KEY"] ?? "";
  if (captchaKey) {
    checks.push({
      code: "captcha_configured",
      level: "info",
      message: "2captcha API key is set",
    });
  } else {
    checks.push({
      code: "captcha_not_configured",
      level: "warn",
      message: "SURFER_CAPTCHA_API_KEY not set",
      detail: "solve_captcha tool will return an error until this is set.",
    });
  }

  // --- Paperclip API (for save_artifact) ---------------------------------------
  const paperclipUrl = process.env["PAPERCLIP_API_URL"] ?? "";
  if (paperclipUrl) {
    checks.push({
      code: "paperclip_api_ok",
      level: "info",
      message: `Paperclip API URL: ${paperclipUrl}`,
    });
  } else {
    checks.push({
      code: "paperclip_api_missing",
      level: "warn",
      message: "PAPERCLIP_API_URL not set — save_artifact will fail",
    });
  }

  return {
    adapterType: "claude_browser_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
