import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerMatrix } from "./catalog.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";
import { renderRunnerHistoryIndex } from "./history-index.js";
import type { RunnerE2ECampaign, RunnerE2EHistoryIndex, RunnerE2EResult } from "./types.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const publicRoot = "https://d1p6rlowie26tp.cloudfront.net/runner-e2e/";
const routeRoot = "/runner-e2e/";
export async function createRunnerReportPreview(options: {
  cacheRoot?: string;
  offline?: boolean;
  refresh?: boolean;
  download?: (relative: string) => Promise<Buffer>;
} = {}) {
  const cacheRoot = options.cacheRoot ?? path.join(repositoryRoot, "tests/runner-e2e/results/design-preview");
  const offline = options.offline ?? false;
  const downloadFile = options.download ?? (async (relative: string) => {
    const response = await fetch(new URL(relative, publicRoot), {
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Public artifact ${relative}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  });
  const version = String(Date.now());
  const inFlight = new Map<string, Promise<Buffer>>();

  interface Manifest {
    campaignId: string;
    files: Array<{ path: string; sha256: string; bytes: number }>;
  }
  type PublishedResult = RunnerE2EResult & { evidenceValid?: boolean; evidenceErrors?: string[] };
  type PublishedCampaign = Omit<RunnerE2ECampaign, "results"> & { results: PublishedResult[] };

  function safePath(relative: string) {
    if (!relative || relative.split("/").some((part) =>
      !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part),
    )) throw new Error("Invalid public artifact path");
    return relative;
  }

  async function publicFile(relative: string, refresh = false): Promise<Buffer> {
    safePath(relative);
    const filename = path.join(cacheRoot, relative);
    if (!refresh || offline) {
      try { return await readFile(filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (offline) throw new Error(`Not cached: ${relative}. Run once without --offline.`);
    const pending = inFlight.get(relative);
    if (pending) return pending;
    const download = (async () => {
      const bytes = await downloadFile(relative);
      await mkdir(path.dirname(filename), { recursive: true });
      const temporary = `${filename}.${process.pid}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, filename);
      return bytes;
    })();
    inFlight.set(relative, download);
    try { return await download; }
    finally { inFlight.delete(relative); }
  }

  async function publicJson<T>(relative: string, refresh = false): Promise<T> {
    return JSON.parse((await publicFile(relative, refresh)).toString("utf8")) as T;
  }

  const retainedHistory = await publicJson<RunnerE2EHistoryIndex>("history.json", options.refresh ?? false);
  if (retainedHistory.schema !== "paperclip.runner-e2e.history/v1") throw new Error("Unsupported public history");
  const campaigns = new Set(retainedHistory.campaigns.map((campaign) => campaign.campaignId));
  const localHistory: RunnerE2EHistoryIndex = {
    ...retainedHistory,
    campaigns: retainedHistory.campaigns.map((campaign) => ({
      ...campaign,
      publicUrl: `${routeRoot}campaigns/${encodeURIComponent(campaign.campaignId)}/`,
    })),
  };
  const manifests = new Map<string, Promise<Manifest>>();
  function manifestFor(campaignId: string) {
    if (!campaigns.has(campaignId)) throw new Error("Unknown campaign");
    let pending = manifests.get(campaignId);
    if (!pending) {
      pending = publicJson<Manifest>(`campaigns/${campaignId}/bundle-manifest.json`).then((manifest) => {
        if (manifest.campaignId !== campaignId || !Array.isArray(manifest.files)) throw new Error("Invalid campaign manifest");
        for (const file of manifest.files) safePath(file.path);
        return manifest;
      });
      manifests.set(campaignId, pending);
      pending.catch(() => manifests.delete(campaignId));
    }
    return pending;
  }

  async function campaignHtml(campaignId: string) {
    const [campaign, manifest] = await Promise.all([
      publicJson<PublishedCampaign>(`campaigns/${campaignId}/normalized-results.json`),
      manifestFor(campaignId),
    ]);
    if (campaign.campaignId !== campaignId || !Array.isArray(campaign.results)) throw new Error("Invalid retained campaign");
    return renderRunnerE2EDashboard({
      title: "Runner Full-Stack E2E",
      generatedAt: campaign.generatedAt,
      expected: campaign.expected,
      catalog: runnerMatrix,
      campaign,
      history: localHistory,
      entries: campaign.results.map((result) => {
        const base = `evidence/${result.executionId}/attempt-${result.attempt}`;
        return {
          result,
          valid: result.status === "passed" && result.cleanup === "passed" && result.evidenceValid !== false,
          errors: result.evidenceErrors ?? [],
          evidenceBaseHref: base,
          evidenceFiles: manifest.files.filter((file) => file.path.startsWith(`${base}/`))
            .map((file) => file.path.slice(base.length + 1)),
        };
      }),
    });
  }

  function withReload(html: string) {
    return html.replace("</body>", `<script>
      const previewVersion = ${JSON.stringify(version)};
      setInterval(async () => {
        try {
          const response = await fetch("/__preview/version", { cache: "no-store" });
          if (response.ok && await response.text() !== previewVersion) location.reload();
        } catch {}
      }, 1000);
    </script></body>`);
  }

  const contentTypes: Record<string, string> = {
    ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8", ".xml": "application/xml",
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end("Read-only preview");
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/__preview/version") {
        response.writeHead(200, { "Content-Type": "text/plain" }).end(version);
        return;
      }
      if (pathname === "/" || pathname === "/runner-e2e") {
        response.writeHead(302, { Location: routeRoot }).end();
        return;
      }
      let html: string | undefined;
      let bytes: Buffer | undefined;
      let extension = ".html";
      if (pathname === routeRoot || pathname === `${routeRoot}index.html`) {
        html = renderRunnerHistoryIndex(localHistory);
      } else if (pathname.startsWith(routeRoot)) {
        const relative = safePath(decodeURIComponent(pathname.slice(routeRoot.length)).replace(/\/$/, ""));
        const campaignMatch = /^campaigns\/([A-Za-z0-9._-]+)(?:\/(.*))?$/.exec(relative);
        if (campaignMatch && campaigns.has(campaignMatch[1]!)) {
          const campaignId = campaignMatch[1]!;
          const artifact = campaignMatch[2];
          if (!artifact || artifact === "index.html" || artifact === "dashboard.html") {
            if (!artifact && !pathname.endsWith("/")) {
              response.writeHead(302, { Location: `${pathname}/` }).end();
              return;
            }
            html = await campaignHtml(campaignId);
          } else if ((await manifestFor(campaignId)).files.some((file) => file.path === artifact)) {
            extension = path.extname(artifact);
            if (contentTypes[extension]) bytes = await publicFile(relative);
          }
        } else if (relative === "history.json") {
          extension = ".json";
          bytes = Buffer.from(JSON.stringify(retainedHistory));
        } else if (relative === "assets/InterVariable.woff2" || relative === "assets/favicon-32x32.png") {
          extension = path.extname(relative);
          bytes = await publicFile(relative);
        }
      }
      if (html !== undefined) bytes = Buffer.from(withReload(html));
      if (!bytes) {
        response.writeHead(404, { "Content-Type": "text/plain" }).end("Preview page or public artifact not found");
        return;
      }
      response.writeHead(200, { "Content-Type": contentTypes[extension] ?? "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }).end(message);
    }
  });
  return { server, campaignCount: campaigns.size, cacheRoot };
}

async function main() {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const portIndex = args.indexOf("--port");
  const port = portIndex < 0 ? 4317 : Number(args[portIndex + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid --port");
  const { server, campaignCount, cacheRoot } = await createRunnerReportPreview({
    offline: args.includes("--offline"), refresh: args.includes("--refresh"),
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
    console.log(`History: ${origin}${routeRoot}`);
    console.log(`${campaignCount} real campaigns; reports and public evidence cache on first access.`);
    console.log(`Cached data: ${cacheRoot}`);
    console.log("Edit history-index.ts or dashboard.ts; Node restarts the preview and the browser reloads.");
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
