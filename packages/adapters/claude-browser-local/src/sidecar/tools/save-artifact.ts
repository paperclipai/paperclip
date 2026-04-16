/**
 * save_artifact — upload a screenshot, DOM, HAR, or arbitrary file to the
 * Paperclip issue attachments endpoint.
 *
 * Environment variables expected (injected by the adapter at sidecar spawn):
 *   SURFER_PAPERCLIP_API_URL   — base URL of the Paperclip API
 *   SURFER_PAPERCLIP_API_KEY   — bearer token
 *   SURFER_PAPERCLIP_COMPANY_ID — company ID
 */

import fs from "node:fs";
import path from "node:path";
import type { SaveArtifactCall, BrowserToolResult } from "../../server/tools/types.js";

const API_URL = process.env["SURFER_PAPERCLIP_API_URL"] ?? "";
const API_KEY = process.env["SURFER_PAPERCLIP_API_KEY"] ?? "";
const COMPANY_ID = process.env["SURFER_PAPERCLIP_COMPANY_ID"] ?? "";

export async function execSaveArtifact(
  call: SaveArtifactCall,
  pngBase64?: string,
  domHtml?: string,
): Promise<BrowserToolResult> {
  const startedAt = new Date().toISOString();

  try {
    if (!API_URL || !API_KEY || !COMPANY_ID) {
      throw new Error(
        "SURFER_PAPERCLIP_API_URL, SURFER_PAPERCLIP_API_KEY, and SURFER_PAPERCLIP_COMPANY_ID must be set",
      );
    }

    let fileBuffer: Buffer;
    let fileName: string;
    let mimeType: string;

    if (call.kind === "screenshot" && pngBase64) {
      fileBuffer = Buffer.from(pngBase64, "base64");
      fileName = `${call.label ?? "screenshot"}.png`;
      mimeType = "image/png";
    } else if (call.kind === "dom" && domHtml) {
      fileBuffer = Buffer.from(domHtml, "utf8");
      fileName = `${call.label ?? "dom"}.html`;
      mimeType = "text/html";
    } else if (call.kind === "file" || call.kind === "har") {
      if (!call.path) {
        throw new Error(`save_artifact kind=${call.kind} requires a path`);
      }
      fileBuffer = fs.readFileSync(call.path);
      fileName = call.label ?? path.basename(call.path);
      mimeType = call.kind === "har" ? "application/json" : "application/octet-stream";
    } else {
      throw new Error(`save_artifact: no data available for kind=${call.kind}`);
    }

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([fileBuffer], { type: mimeType }),
      fileName,
    );

    const response = await fetch(
      `${API_URL}/api/companies/${COMPANY_ID}/issues/${call.attachToIssueId}/attachments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      throw new Error(`Paperclip API ${response.status}: ${text.slice(0, 200)}`);
    }

    const attachment = (await response.json()) as { id: string; [k: string]: unknown };

    return {
      ok: true,
      tool: "save_artifact",
      startedAt,
      finishedAt: new Date().toISOString(),
      attachmentId: attachment.id,
      data: {
        fileName,
        sizeBytes: fileBuffer.length,
        label: call.label ?? null,
        issueId: call.attachToIssueId,
      },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      tool: "save_artifact",
      startedAt,
      finishedAt: new Date().toISOString(),
      errorMessage: err instanceof Error ? err.message : String(err),
      errorCode: "SAVE_ARTIFACT_FAILED",
    };
  }
}
