#!/usr/bin/env -S node --import tsx
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DesignerController } from './designer-controller.ts';
import { sessionDir } from './artifact-store.ts';
import { maybeRenewLease } from './lease-renew.js';

const server = new McpServer({ name: 'designer', version: '0.3.0' });
const controllers = new Map<string, DesignerController>();

function getController(key: string | undefined): DesignerController {
  const k = key || 'default';
  if (!controllers.has(k)) controllers.set(k, new DesignerController({ key: k, headed: true }));
  return controllers.get(k)!;
}

function textResult(obj: unknown) {
  return {
    content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
    structuredContent: typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>) : undefined
  };
}

server.registerTool(
  'designer_session',
  {
    description:
      "Enter, inspect, or transition a claude.ai/design session. Default action='status' is a pure read — safe to call anytime to orient without side effects. Returns stored state + currentUrl + inSession + availableFiles so you can avoid a follow-up list call. Use this as the first tool in any agent loop.\n\nActions:\n- status (default): read-only, no mutations\n- ensure_ready: navigate to /design if not already there\n- resume: navigate into the stored designUrl for this key (fails if nothing stored)\n- create: new project (requires name)",
    inputSchema: {
      key: z.string().optional().describe('Stable key for this loop (e.g., feature name). Defaults to "default".'),
      action: z.enum(['status', 'ensure_ready', 'resume', 'create']).optional().describe('Default: status'),
      name: z.string().optional().describe('Required when action=create.'),
      fidelity: z.enum(['wireframe', 'highfi']).optional().describe('Locked at creation. Default wireframe.')
    }
  },
  async ({ key, action = 'status', name, fidelity }) => {
    await maybeRenewLease();
    return textResult(await getController(key).session({ action, name, fidelity }));
  }
);

server.registerTool(
  'designer_prompt',
  {
    description:
      "Modify the design. Sends a prompt you expect to change the served HTML (e.g., 'create a login screen', 'add a Remember-me checkbox'). Waits for HTML to change and stabilize. Returns slim metadata — NOT inline HTML (written to disk at htmlPath).\n\n**Default taste path: hand the human `url` from the return.** The URL is the live claude.ai/design surface — fully interactive, tweak sliders work, variant switcher works. Only reach for `designer tasting` when full-viewport comparison matters more than interactivity.\n\nAuto-appended to every prompt: an instruction to keep all generated files at the project root (no subfolders). The live MCP's file-list scrape is flat-only; subfolder-nested files are invisible until `designer_handoff`. If you need nested layouts, explicitly contradict this in your prompt.\n\nKey return fields:\n- url: live URL to show the human (default taste path)\n- done.failureMode: null | 'timeout' | 'unstable' | 'no_change' (no_change means Claude replied text-only — did you want designer_ask?)\n- newFiles / removedFiles: diff vs pre-send\n- activeFile: what's currently rendered\n- htmlPath / screenshotPath: read these only if you need the content\n- chatReply: Claude's commentary",
    inputSchema: {
      key: z.string().optional(),
      prompt: z.string(),
      file: z.string().optional().describe('Switch to this file before sending (targets the prompt at it).'),
      timeoutMs: z.number().optional().describe('Default 20m. Hi-fi generations can take 15+ min; bump this for complex multi-variant prompts.'),
      stabilityMs: z.number().optional().describe('Default 4s.'),
      decisive: z
        .boolean()
        .optional()
        .describe(
          "Append a 'do not stop to ask clarifying questions' instruction. Use when you want Claude to commit to a direction (pick defensible defaults itself, document the assumption inline) instead of blocking on the ephemeral clarifying-questions affordance — which disappears on refresh and has no stable DOM contract to scrape."
        )
    }
  },
  async ({ key, prompt, file, timeoutMs, stabilityMs, decisive }) => {
    await maybeRenewLease();
    return textResult(await getController(key).iterate(prompt, { file, timeoutMs, stabilityMs, decisive }));
  }
);

server.registerTool(
  'designer_ask',
  {
    description:
      "Q&A with the design assistant — text-only, doesn't change any file. Use for 'why did you choose X?', 'compare A vs B', 'suggest 3 alternatives before I commit'. Returns the assistant's reply.",
    inputSchema: {
      key: z.string().optional(),
      prompt: z.string(),
      file: z.string().optional().describe('Switch to this file before asking (gives Claude context).'),
      timeoutMs: z.number().optional().describe('Default 5m.'),
      stabilityMs: z.number().optional().describe('Default 2.5s.')
    }
  },
  async ({ key, prompt, file, timeoutMs, stabilityMs }) => {
    await maybeRenewLease();
    return textResult(await getController(key).ask(prompt, { file, timeoutMs, stabilityMs }));
  }
);

server.registerTool(
  'designer_list',
  {
    description:
      "Inventory. scope='projects' lists all your Claude design projects; scope='files' lists files in the currently-open project. Usually you won't need this — designer_session already returns availableFiles, and designer_prompt returns newFiles.",
    inputSchema: {
      key: z.string().optional(),
      scope: z.enum(['projects', 'files'])
    }
  },
  async ({ key, scope }) => {
    await maybeRenewLease();
    const c = getController(key);
    if (scope === 'projects') return textResult(await c.listProjects());
    const detail = await c.listFilesDetailed();
    if (!detail.authoritative) {
      return textResult({
        files: detail.files,
        folders: detail.folders,
        authoritative: false,
        warning:
          'This project has folders (' +
          detail.folders.join(', ') +
          '). Files under folders are not visible to the live file-list scrape. Call designer_handoff for an authoritative list.'
      });
    }
    return textResult({ files: detail.files, authoritative: true });
  }
);

server.registerTool(
  'designer_snapshot',
  {
    description:
      "Inspect a file's current state. Switches to `filename` first if given. Default returns paths + hash only (no inline HTML — read htmlPath if you need the content). Set includeHtml=true to get the HTML inline.",
    inputSchema: {
      key: z.string().optional(),
      filename: z.string().optional().describe('Switch to this file first. Omit to snapshot whatever is active.'),
      includeHtml: z.boolean().optional().describe('Default false.'),
      screenshot: z.boolean().optional().describe('Default true.')
    }
  },
  async ({ key, filename, includeHtml = false, screenshot = true }) => {
    await maybeRenewLease();
    const c = getController(key);
    if (filename) {
      const swap = await c.openFile(filename);
      if (!swap.ok) return textResult({ ok: false, error: swap.error, file: filename });
    }
    const snap = await c.snapshotDesign({});
    let htmlPath: string | null = null;
    if (snap.html) {
      htmlPath = path.join(sessionDir(c.key), `snap-${Date.now()}.html`);
      fs.writeFileSync(htmlPath, snap.html);
    }
    return textResult({
      ok: true,
      file: filename || extractFileParamFromUrl(snap.url),
      url: snap.url,
      iframeSrc: snap.iframeSrc,
      htmlPath,
      screenshotPath: screenshot ? snap.screenshotPath : null,
      htmlBytes: snap.html ? snap.html.length : 0,
      htmlHash: snap.html ? simpleHash(snap.html) : null,
      html: includeHtml ? snap.html : undefined
    });
  }
);

server.registerTool(
  'designer_handoff',
  {
    description:
      "Promote: trigger Export → Handoff to Claude Code, download the public tar.gz bundle (no auth), extract under ./artifacts/{key}/handoff-{ts}/. Bundle contains README.md, chat transcripts (decision record — every prompt + reply, verbatim), all design files, standalone HTML, shared CSS, design-canvas.jsx. Call when the human says 'yes, that's it'.",
    inputSchema: {
      key: z.string().optional(),
      openFile: z.string().optional().describe('Set the open file before handoff.')
    }
  },
  async ({ key, openFile }) => {
    await maybeRenewLease();
    return textResult(await getController(key).handoff({ openFile }));
  }
);

function extractFileParamFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get('file');
  } catch {
    return null;
  }
}

function simpleHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run server when invoked directly (node mcp-server.ts or via bin/designer-mcp).
// Skip when imported (cli.ts uses startMcpServer for the `mcp serve` subcommand).
const __isDirectInvoke =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('mcp-server.ts') ||
  process.argv[1]?.endsWith('mcp-server.js');
if (__isDirectInvoke) {
  await startMcpServer();
}
