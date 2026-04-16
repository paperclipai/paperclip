/**
 * Playwright sidecar entrypoint.
 *
 * Usage:
 *   node dist/sidecar/index.js \
 *     --socket /var/run/paperclip/surfer.sock \
 *     --profile /var/lib/surfer/profile
 *
 * Or via env:
 *   SURFER_SOCKET_PATH=/path/to.sock SURFER_PROFILE_DIR=/path/profile
 *
 * Listens for JSON-RPC 2.0 requests from the adapter and dispatches to tool handlers.
 */

import process from "node:process";
import { SidecarBrowser } from "./browser.js";
import { RpcServer } from "./rpc.js";
import { execGoto } from "./tools/goto.js";
import { execClick } from "./tools/click.js";
import { execType } from "./tools/type.js";
import { execSaveArtifact } from "./tools/save-artifact.js";
import { execWaitFor } from "./tools/wait-for.js";
import { execScreenshot } from "./tools/screenshot.js";
import { resolveSecretToken } from "../server/tools/secrets.js";
import type { BrowserToolCall, BrowserToolResult } from "../server/tools/types.js";

// --- Config -----------------------------------------------------------------

function parseArgs(): { socketPath: string; profileDir: string } {
  const args = process.argv.slice(2);
  let socketPath = process.env.SURFER_SOCKET_PATH ?? "/var/run/paperclip/surfer.sock";
  let profileDir = process.env.SURFER_PROFILE_DIR ?? "/var/lib/surfer/profile";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--socket" && args[i + 1]) socketPath = args[++i];
    if (args[i] === "--profile" && args[i + 1]) profileDir = args[++i];
  }

  return { socketPath, profileDir };
}

// --- Secret resolution -------------------------------------------------------

/**
 * Reads secrets from SURFER_SECRET_<NAME> env vars.
 * Secrets are injected by the adapter process before spawning the sidecar.
 */
function resolveSecrets(value: string): string {
  return value.replace(/\{\{SECRET:([A-Z0-9_]+)\}\}/g, (_match, name: string) => {
    const envKey = `SURFER_SECRET_${name}`;
    const resolved = process.env[envKey];
    if (!resolved) throw new Error(`Unresolved secret: ${name} (set ${envKey})`);
    return resolved;
  });
}

// --- Dispatcher --------------------------------------------------------------

async function dispatch(
  browser: SidecarBrowser,
  call: BrowserToolCall,
): Promise<BrowserToolResult> {
  const page = browser.getPage();

  switch (call.tool) {
    case "goto":
      return execGoto(page, call);

    case "click":
      return execClick(page, call);

    case "type": {
      const resolved = resolveSecrets(call.value);
      return execType(page, call, resolved);
    }

    case "wait_for":
      return execWaitFor(page, call);

    case "screenshot":
      return execScreenshot(page, call);

    case "select": {
      const startedAt = new Date().toISOString();
      try {
        await page.locator(call.selector).selectOption(call.value);
        return {
          ok: true, tool: "select", startedAt,
          finishedAt: new Date().toISOString(),
          data: { selector: call.selector, value: call.value },
        };
      } catch (err: unknown) {
        return {
          ok: false, tool: "select", startedAt,
          finishedAt: new Date().toISOString(),
          errorMessage: err instanceof Error ? err.message : String(err),
          errorCode: "SELECT_FAILED",
        };
      }
    }

    case "dom_snapshot": {
      const startedAt = new Date().toISOString();
      try {
        const html = call.selector
          ? await page.locator(call.selector).first().innerHTML()
          : await page.content();
        return {
          ok: true, tool: "dom_snapshot", startedAt,
          finishedAt: new Date().toISOString(),
          data: { html, url: page.url() },
        };
      } catch (err: unknown) {
        return {
          ok: false, tool: "dom_snapshot", startedAt,
          finishedAt: new Date().toISOString(),
          errorMessage: err instanceof Error ? err.message : String(err),
          errorCode: "DOM_SNAPSHOT_FAILED",
        };
      }
    }

    case "submit_form": {
      const startedAt = new Date().toISOString();
      try {
        for (const field of call.fields) {
          await page.locator(field.selector).fill(field.value);
        }
        if (call.submitSelector) {
          await page.locator(call.submitSelector).click();
        } else {
          await page.locator(call.formSelector).evaluate((form: HTMLFormElement) => form.submit());
        }
        if (call.waitForSelector) {
          await page.locator(call.waitForSelector).waitFor({ state: "visible", timeout: 15_000 });
        }
        return {
          ok: true, tool: "submit_form", startedAt,
          finishedAt: new Date().toISOString(),
          data: { url: page.url() },
        };
      } catch (err: unknown) {
        return {
          ok: false, tool: "submit_form", startedAt,
          finishedAt: new Date().toISOString(),
          errorMessage: err instanceof Error ? err.message : String(err),
          errorCode: "SUBMIT_FORM_FAILED",
        };
      }
    }

    case "read_inbox":
      // IMAP client lands Day 4; stub for now.
      return {
        ok: false, tool: "read_inbox",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        errorMessage: "read_inbox not implemented in Day 2 build — lands Day 4",
        errorCode: "NOT_IMPLEMENTED",
      };

    case "solve_captcha":
      // 2captcha client lands Day 4.
      return {
        ok: false, tool: "solve_captcha",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        errorMessage: "solve_captcha not implemented in Day 2 build — lands Day 4",
        errorCode: "NOT_IMPLEMENTED",
      };

    case "save_artifact": {
      // For screenshot saves, re-take the screenshot so we pass the buffer.
      // For dom saves, grab the current page HTML.
      let pngBase64: string | undefined;
      let domHtml: string | undefined;
      if (call.kind === "screenshot") {
        const buf = await page.screenshot({ fullPage: false, type: "png" });
        pngBase64 = buf.toString("base64");
      } else if (call.kind === "dom") {
        domHtml = await page.content();
      }
      return execSaveArtifact(call, pngBase64, domHtml);
    }

    default: {
      const exhaustive: never = call;
      return {
        ok: false, tool: (exhaustive as BrowserToolCall).tool,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        errorMessage: `Unknown tool: ${(exhaustive as BrowserToolCall).tool}`,
        errorCode: "UNKNOWN_TOOL",
      };
    }
  }
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  const { socketPath, profileDir } = parseArgs();

  const browser = new SidecarBrowser(profileDir);
  await browser.start();
  console.error(`[surfer-sidecar] Browser started (profile: ${profileDir})`);

  const rpc = new RpcServer(socketPath, async (method, params) => {
    if (method === "ping") return { pong: true };

    if (method === "browser_tool") {
      const call = params as BrowserToolCall;
      return dispatch(browser, call);
    }

    throw new Error(`Unknown method: ${method}`);
  });

  await rpc.listen();
  console.error(`[surfer-sidecar] Listening on ${socketPath}`);

  // Graceful shutdown
  const shutdown = async () => {
    console.error("[surfer-sidecar] Shutting down...");
    await rpc.close();
    await browser.stop();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[surfer-sidecar] Fatal:", err);
  process.exit(1);
});
