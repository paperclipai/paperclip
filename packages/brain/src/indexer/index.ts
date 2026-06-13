import chokidar from "chokidar";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../shared/config.js";
import { createBrainDb } from "../db/client.js";
import { createEmbedder } from "./embedder.js";
import { indexFile, removeFile } from "./watcher.js";
import { fullRescan } from "./rescan.js";

const RESCAN_INTERVAL_MS = 60 * 60 * 1000;

async function waitForVault(vaultRoot: string, retrySeconds: number): Promise<void> {
  let logged = false;
  while (true) {
    try {
      const st = fs.statSync(vaultRoot);
      if (st.isDirectory()) return;
    } catch {
      // not yet available
    }
    if (!logged) {
      console.log(`[indexer] vault ${vaultRoot} unavailable; retrying every ${retrySeconds}s`);
      logged = true;
    }
    await new Promise((r) => setTimeout(r, retrySeconds * 1000));
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const handle = createBrainDb(cfg.brainDatabaseUrl);
  const embed = createEmbedder({ baseUrl: cfg.lmStudioUrl, model: cfg.embeddingModel });

  const vaultRoot = path.resolve(cfg.vaultPath);
  const rel = (abs: string): string =>
    path.relative(vaultRoot, abs).split(path.sep).join("/");

  console.log(`[indexer] vault=${vaultRoot}`);
  await waitForVault(vaultRoot, cfg.vaultWaitRetrySeconds);
  console.log("[indexer] startup full rescan...");
  const startStats = await fullRescan(handle, embed, vaultRoot, (c, last) => {
    if (c.total > 0 && (c.indexed + c.unchanged + c.skipped + c.errors) % 100 === 0) {
      console.log(
        `[rescan] ${c.indexed + c.unchanged + c.skipped + c.errors}/${c.total} (${last})`,
      );
    }
  });
  console.log("[indexer] initial rescan done:", startStats);

  console.log(`[indexer] starting chokidar on ${vaultRoot}`);
  const watcher = chokidar.watch(vaultRoot, {
    ignored: (p) => /[\\/]\.(obsidian|trash|git)([\\/]|$)/.test(p),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 250 },
    usePolling: cfg.watchUsePolling,
    interval: cfg.watchPollIntervalMs,
    binaryInterval: cfg.watchPollIntervalMs,
  });
  console.log(
    `[indexer] watch mode: ${cfg.watchUsePolling ? `polling@${cfg.watchPollIntervalMs}ms` : "fsevents"}`,
  );

  watcher.on("add", async (abs) => {
    try {
      const r = await indexFile(handle, embed, vaultRoot, rel(abs));
      console.log(`[indexer] add ${rel(abs)} → ${r}`);
    } catch (e) {
      console.error(`[indexer] add error ${rel(abs)}:`, e instanceof Error ? e.message : e);
    }
  });
  watcher.on("change", async (abs) => {
    try {
      const r = await indexFile(handle, embed, vaultRoot, rel(abs));
      console.log(`[indexer] change ${rel(abs)} → ${r}`);
    } catch (e) {
      console.error(`[indexer] change error ${rel(abs)}:`, e instanceof Error ? e.message : e);
    }
  });
  watcher.on("unlink", async (abs) => {
    try {
      await removeFile(handle, rel(abs));
      console.log(`[indexer] unlink ${rel(abs)}`);
    } catch (e) {
      console.error(`[indexer] unlink error ${rel(abs)}:`, e instanceof Error ? e.message : e);
    }
  });

  setInterval(async () => {
    console.log("[indexer] hourly safety rescan starting...");
    try {
      const stats = await fullRescan(handle, embed, vaultRoot);
      console.log("[indexer] safety rescan done:", stats);
    } catch (e) {
      console.error("[indexer] safety rescan failed:", e instanceof Error ? e.message : e);
    }
  }, RESCAN_INTERVAL_MS);

  const shutdown = async (): Promise<void> => {
    console.log("[indexer] shutting down...");
    await watcher.close();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[indexer] ready. watching for changes.");
}

main().catch((e) => {
  console.error("[indexer] fatal:", e);
  process.exit(1);
});
