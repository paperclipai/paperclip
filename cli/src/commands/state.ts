import * as p from "@clack/prompts";
import pc from "picocolors";
import { printPaperclipCliBanner } from "../utils/banner.js";

type StateApiOptions = { apiUrl?: string; token?: string; json?: boolean };

async function callStateApi(pathname: string, opts: StateApiOptions, body?: unknown) {
  const apiUrl = (opts.apiUrl?.trim() || process.env.PAPERCLIP_API_URL?.trim() || "http://127.0.0.1:3100/api").replace(/\/$/, "");
  const token = opts.token?.trim() || process.env.PAPERCLIP_API_KEY?.trim();
  const response = await fetch(`${apiUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : `Request failed (${response.status})`);
  return result;
}

export async function stateSnapshotCommand(opts: StateApiOptions) {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip state snapshot ")));
  const result = await callStateApi("/instance/state-snapshots", opts);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else p.outro(pc.green(`Snapshot stored: ${result.objectKey}`));
}

export async function stateRestoreCommand(objectKey: string, opts: StateApiOptions) {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip state restore ")));
  const result = await callStateApi("/instance/state-snapshots/restore", opts, { objectKey });
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else p.outro(pc.green(`Snapshot restored: ${objectKey}`));
}
