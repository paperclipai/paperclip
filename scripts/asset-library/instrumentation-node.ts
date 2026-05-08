// Node-only instrumentation — bundled only for the nodejs runtime by Next 14.
// GLA-989: starts the IssueDocument auto-comment poller.
//
// Disable with `ASSET_LIBRARY_POLLER_DISABLED=1`.

import path from "path";
import { startPoller } from "./lib/poller";

if (process.env.ASSET_LIBRARY_POLLER_DISABLED === "1") {
  console.log("[asset-library/poller] disabled via ASSET_LIBRARY_POLLER_DISABLED");
} else {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!apiUrl || !apiKey || !companyId) {
    console.warn("[asset-library/poller] missing env — not starting", {
      PAPERCLIP_API_URL: !!apiUrl,
      PAPERCLIP_API_KEY: !!apiKey,
      PAPERCLIP_COMPANY_ID: !!companyId,
    });
  } else {
    const stateFile = path.resolve(process.cwd(), ".doc-state.json");
    const intervalRaw = Number(process.env.ASSET_LIBRARY_POLL_INTERVAL_MS ?? "30000");
    const intervalMs =
      Number.isFinite(intervalRaw) && intervalRaw >= 1000 ? intervalRaw : 30000;
    const assetLibraryUrl = process.env.ASSET_LIBRARY_URL ?? "http://127.0.0.1:7700";
    startPoller({ apiUrl, apiKey, companyId, assetLibraryUrl, stateFile, intervalMs });
  }
}
