#!/usr/bin/env npx tsx
import { Command } from "commander";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import pc from "picocolors";

import { HigherGovClient } from "../core/highergov-client.js";
import { RfpMartClient } from "../core/rfpmart-client.js";
import { BidPrimeClient } from "../core/bidprime-client.js";
import { BidPrimeSessionClient } from "../core/bidprime-session-client.js";
import { loadBidPrimeSession } from "../core/bidprime-session.js";
import { extractDocuments } from "../core/pdf-extractor.js";
import { scoreOpportunityWithDocument } from "../core/scorer.js";
import { deduplicateByOpportunityId } from "../core/dedup.js";
import { crossSourceDedup } from "../core/cross-source-dedup.js";
import { applyHardFilters } from "../core/hard-filter.js";
import { scoreBatch } from "../core/scorer.js";
import { HubSpotClient } from "../core/hubspot-client.js";
import {
  ENV_VARS,
  MONTHLY_API_QUOTA,
  DEFAULT_MIN_SCORE,
} from "../core/constants.js";
import type { NormalizedOpportunity, PipelineResult, ScoredOpportunity } from "../core/types.js";
import { loadState, saveState, getStateDir } from "./state.js";
import { writeJson, writeCsv, writeQualifiedCsv, printSummary, printQuota } from "./output.js";

const RFPMART_CUSTOMER_ID = "20250926CMB9586739092";

const program = new Command();

program
  .name("govbids")
  .description(
    "Government bid filtering pipeline for ConsultAdd Public Services",
  )
  .version("0.1.0");

// ── fetch ──────────────────────────────────────────────────────────
program
  .command("fetch")
  .description(
    "Fetch opportunities from HigherGov, deduplicate, and apply hard filters",
  )
  .option("--since <date>", "Only fetch opportunities captured after this date")
  .option(
    "--highergov-key <key>",
    "HigherGov API key",
    process.env[ENV_VARS.higherGovApiKey],
  )
  .option("--dry-run", "Show what would be fetched without making API calls")
  .option("--broad", "Use extended NAICS codes and wider value range ($50K-$2M)")
  .option("--max-records <n>", "Max records to fetch across all searches", "500")
  .action(async (opts) => {
    if (opts.dryRun) {
      console.log(pc.yellow("DRY RUN — no API calls will be made"));
      console.log("Would fetch from HigherGov by NAICS code");
      console.log("Would apply hard filters (type, NAICS, value, due date)");
      return;
    }

    const apiKey = opts.highergovKey;
    if (!apiKey) {
      console.error(
        pc.red(
          `Error: HigherGov API key required. Set ${ENV_VARS.higherGovApiKey} or use --highergov-key`,
        ),
      );
      process.exit(1);
    }

    const state = await loadState();
    const since = opts.since ?? state.lastCapturedDate ?? undefined;
    const broad = !!opts.broad;

    console.log(pc.bold("Fetching from HigherGov..."));
    if (since) console.log(`  Since: ${since}`);
    if (broad) console.log(`  Mode: ${pc.cyan("BROAD")} (extended NAICS, $50K-$2M value range)`);

    const client = new HigherGovClient({ apiKey });
    const { opportunities, apiCallsUsed } =
      await client.fetchAllKeywordSearches({
        capturedAfter: since,
        useExtendedNaics: broad,
        maxRecords: parseInt(opts.maxRecords, 10),
      });

    console.log(`  Fetched: ${opportunities.length} raw opportunities`);
    console.log(`  API calls: ${apiCallsUsed}`);

    // Dedup
    const deduped = deduplicateByOpportunityId(opportunities);
    console.log(`  After dedup: ${deduped.length}`);

    // Hard filter (wider value range in broad mode)
    const filterConfig = broad
      ? { valueRange: { min: 50_000, max: 2_000_000 } }
      : undefined;
    const { kept, dropped } = applyHardFilters(deduped, filterConfig);
    console.log(`  After hard filter: ${kept.length} kept, ${dropped.length} dropped`);

    // Save output
    const dataDir = getStateDir();
    await mkdir(dataDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const outFile = join(dataDir, `opportunities-${dateStr}.json`);
    await writeJson(
      {
        scored: kept.map((o) => ({
          ...o,
          score: 0,
          scoreBreakdown: {
            serviceAlignment: 0,
            bidReadiness: 0,
            competitivePosition: 0,
            valueFit: 0,
          },
          serviceCategory: "mixed" as const,
          reasoning: "Not yet scored",
          disqualifiers: [],
        })),
        dropped,
        stats: {
          totalFetched: opportunities.length,
          afterDedup: deduped.length,
          afterHardFilter: kept.length,
          scored: 0,
          aboveThreshold: 0,
          apiCallsUsed,
          claudeCallsUsed: 0,
        },
        runDate: new Date().toISOString(),
      },
      outFile,
    );

    // Update state
    state.lastRunDate = new Date().toISOString();
    state.monthlyApiCallsUsed += apiCallsUsed;
    if (opportunities.length > 0) {
      const latestCapture = opportunities
        .filter((o) => o.capturedDate)
        .sort(
          (a, b) =>
            new Date(b.capturedDate!).getTime() -
            new Date(a.capturedDate!).getTime(),
        )[0]?.capturedDate;
      if (latestCapture) state.lastCapturedDate = latestCapture;
    }
    await saveState(state);

    console.log(pc.green(`\nSaved to ${outFile}`));
  });

// ── score ──────────────────────────────────────────────────────────
program
  .command("score")
  .description("Score fetched opportunities using Claude LLM")
  .option("--file <path>", "Path to fetched opportunities JSON")
  .option("--min-score <n>", "Minimum score threshold", String(DEFAULT_MIN_SCORE))
  .option(
    "--claude-key <key>",
    "Anthropic API key",
    process.env[ENV_VARS.claudeApiKey],
  )
  .option("--output-format <fmt>", "Output format: json, csv, or both", "both")
  .action(async (opts) => {
    const apiKey = opts.claudeKey;
    if (!apiKey) {
      console.error(
        pc.red(
          `Error: Anthropic API key required. Set ${ENV_VARS.claudeApiKey} or use --claude-key`,
        ),
      );
      process.exit(1);
    }

    // Find input file
    const dataDir = getStateDir();
    let inputFile = opts.file;
    if (!inputFile) {
      const dateStr = new Date().toISOString().slice(0, 10);
      inputFile = join(dataDir, `opportunities-${dateStr}.json`);
    }

    console.log(pc.bold(`Scoring opportunities from ${inputFile}...`));

    const raw = await readFile(inputFile, "utf-8");
    const data = JSON.parse(raw) as PipelineResult;
    const toScore = data.scored.filter((o) => o.score === 0);

    if (toScore.length === 0) {
      console.log(pc.yellow("No unscored opportunities found."));
      return;
    }

    console.log(`  Scoring ${toScore.length} opportunities...`);

    const scored = await scoreBatch(toScore, {
      apiKey,
      onProgress: (done, total) => {
        process.stdout.write(
          `\r  Progress: ${done}/${total} (${Math.round((done / total) * 100)}%)`,
        );
      },
    });

    console.log(""); // newline after progress

    const minScore = parseInt(opts.minScore, 10);
    const aboveThreshold = scored.filter((o) => o.score >= minScore);

    const result: PipelineResult = {
      scored,
      dropped: data.dropped,
      stats: {
        ...data.stats,
        scored: scored.length,
        aboveThreshold: aboveThreshold.length,
        claudeCallsUsed: scored.length,
      },
      runDate: new Date().toISOString(),
    };

    // Save outputs
    const dateStr = new Date().toISOString().slice(0, 10);
    const fmt = opts.outputFormat;

    if (fmt === "json" || fmt === "both") {
      const jsonFile = join(dataDir, `scored-${dateStr}.json`);
      await writeJson(result, jsonFile);
      console.log(pc.green(`JSON saved to ${jsonFile}`));
    }

    if (fmt === "csv" || fmt === "both") {
      const qualifiedFile = join(dataDir, `qualified-${dateStr}.csv`);
      const rejectedFile = join(dataDir, `rejected-${dateStr}.csv`);
      await writeQualifiedCsv(scored, minScore, qualifiedFile, rejectedFile);
      console.log(pc.green(`Qualified CSV saved to ${qualifiedFile}`));
      console.log(pc.dim(`Rejected CSV saved to ${rejectedFile}`));
    }

    printSummary(result);
  });

// ── push ───────────────────────────────────────────────────────────
program
  .command("push")
  .description("Push scored opportunities to HubSpot as Deals")
  .option("--file <path>", "Path to scored opportunities JSON")
  .option("--min-score <n>", "Only push opportunities above this score", String(DEFAULT_MIN_SCORE))
  .option(
    "--hubspot-key <key>",
    "HubSpot API key",
    process.env[ENV_VARS.hubspotApiKey],
  )
  .option("--dry-run", "Show what would be pushed without making API calls")
  .action(async (opts) => {
    const apiKey = opts.hubspotKey;
    if (!apiKey && !opts.dryRun) {
      console.error(
        pc.red(
          `Error: HubSpot API key required. Set ${ENV_VARS.hubspotApiKey} or use --hubspot-key`,
        ),
      );
      process.exit(1);
    }

    const dataDir = getStateDir();
    let inputFile = opts.file;
    if (!inputFile) {
      const dateStr = new Date().toISOString().slice(0, 10);
      inputFile = join(dataDir, `scored-${dateStr}.json`);
    }

    const raw = await readFile(inputFile, "utf-8");
    const data = JSON.parse(raw) as PipelineResult;
    const minScore = parseInt(opts.minScore, 10);
    const toPush = data.scored.filter((o) => o.score >= minScore);

    console.log(
      pc.bold(
        `${toPush.length} opportunities above score ${minScore} to push to HubSpot`,
      ),
    );

    if (opts.dryRun) {
      console.log(pc.yellow("\nDRY RUN — showing what would be pushed:\n"));
      for (const opp of toPush) {
        console.log(`  [${opp.score}] ${opp.title} — ${opp.agency} (${opp.state ?? "N/A"})`);
      }
      return;
    }

    const client = new HubSpotClient({ apiKey: apiKey! });
    const result = await client.createDeals(toPush);

    console.log(pc.green(`  Created: ${result.created.length} deals`));
    if (result.skipped.length > 0) {
      console.log(pc.yellow(`  Skipped (already exist): ${result.skipped.length}`));
    }
    if (result.errors.length > 0) {
      console.log(pc.red(`  Errors: ${result.errors.length}`));
      for (const err of result.errors) {
        console.log(pc.red(`    ${err.id}: ${err.error}`));
      }
    }
  });

// ── run ────────────────────────────────────────────────────────────
program
  .command("run")
  .description("Full pipeline: fetch + score (does NOT auto-push to HubSpot)")
  .option("--since <date>", "Only fetch opportunities captured after this date")
  .option(
    "--highergov-key <key>",
    "HigherGov API key",
    process.env[ENV_VARS.higherGovApiKey],
  )
  .option(
    "--claude-key <key>",
    "Anthropic API key",
    process.env[ENV_VARS.claudeApiKey],
  )
  .option("--min-score <n>", "Minimum score threshold", String(DEFAULT_MIN_SCORE))
  .option("--output-format <fmt>", "Output format: json, csv, or both", "both")
  .option("--dry-run", "Show what would happen without making API calls")
  .option("--broad", "Use extended NAICS codes and wider value range ($50K-$2M)")
  .option("--max-records <n>", "Max records to fetch across all searches", "1000")
  .option("--rfpmart", "Also fetch from RFPMart and deduplicate across sources")
  .option("--rfpmart-days <n>", "Number of days to fetch from RFPMart (max 30)", "7")
  .option("--bidprime", "Also fetch from BidPrime via public REST API (bearer token)")
  .option("--bidprime-session", "Fetch from BidPrime via session cookie (uses .bidprime-session file)")
  .option("--bidprime-session-file <path>", "Path to BidPrime session cookie file", ".bidprime-session")
  .option("--bidprime-user-id <n>", "BidPrime numeric userId (required with --bidprime-session)")
  .option("--bidprime-max <n>", "Cap on bids fetched via session (for testing)")
  .option("--bidprime-enrich", "Enrich each bid with /bid/get for the rich ~4KB description (slower)")
  .option("--no-highergov", "Skip HigherGov fetch (useful when only using --bidprime-session)")
  .action(async (opts) => {
    if (opts.bidprime && opts.bidprimeSession) {
      console.error(pc.red("Error: --bidprime and --bidprime-session are mutually exclusive"));
      process.exit(1);
    }
    if (opts.dryRun) {
      console.log(pc.yellow("DRY RUN — no API calls will be made"));
      console.log("1. Would fetch from HigherGov by NAICS code");
      if (opts.rfpmart) console.log("   + Would fetch from RFPMart (US IT categories)");
      if (opts.bidprime) console.log("   + Would fetch from BidPrime via public REST API");
      if (opts.bidprimeSession) console.log("   + Would fetch from BidPrime via session cookie");
      console.log("2. Would deduplicate (within + across sources)");
      console.log("3. Would apply hard filters and score with Claude");
      console.log("4. Would output ranked qualified/rejected CSV files");
      console.log("5. Would NOT auto-push to HubSpot (use 'push' command)");
      return;
    }

    const higherGovKey = opts.highergovKey;
    const claudeKey = opts.claudeKey;
    const otherSourceEnabled = !!(opts.rfpmart || opts.bidprime || opts.bidprimeSession);
    const skipHigherGov = opts.highergov === false || (otherSourceEnabled && !higherGovKey);

    if (!higherGovKey && !otherSourceEnabled) {
      console.error(pc.red(`Error: Set ${ENV_VARS.higherGovApiKey} or use --highergov-key (or enable another source via --rfpmart / --bidprime / --bidprime-session)`));
      process.exit(1);
    }
    if (!claudeKey) {
      console.error(pc.red(`Error: Set ${ENV_VARS.claudeApiKey} or use --claude-key`));
      process.exit(1);
    }

    const state = await loadState();
    const since = opts.since ?? state.lastCapturedDate ?? undefined;
    const broad = !!opts.broad;

    console.log(pc.bold("Step 1: Fetching opportunities..."));
    if (broad) console.log(`  Mode: ${pc.cyan("BROAD")} (extended NAICS, $50K-$2M value range)`);

    let allOpportunities: NormalizedOpportunity[] = [];
    let totalApiCalls = 0;

    // Step 1a: Fetch from HigherGov
    if (!skipHigherGov && higherGovKey) {
      console.log(pc.dim("\n  [HigherGov]"));
      const hgClient = new HigherGovClient({ apiKey: higherGovKey });
      const { opportunities: hgOpps, apiCallsUsed: hgCalls } =
        await hgClient.fetchAllKeywordSearches({
          capturedAfter: since,
          useExtendedNaics: broad,
          maxRecords: parseInt(opts.maxRecords, 10),
        });
      console.log(`  HigherGov: ${hgOpps.length} opportunities (${hgCalls} API calls)`);
      allOpportunities.push(...hgOpps);
      totalApiCalls += hgCalls;
    }

    // Step 1b: Fetch from RFPMart (if enabled)
    if (opts.rfpmart) {
      console.log(pc.dim("\n  [RFPMart]"));
      const rfpClient = new RfpMartClient({ customerId: RFPMART_CUSTOMER_ID });
      const rfpDays = parseInt(opts.rfpmartDays, 10);
      const { opportunities: rfpOpps, apiCallsUsed: rfpCalls } =
        await rfpClient.fetchRecentDays(rfpDays);
      console.log(`  RFPMart: ${rfpOpps.length} IT opportunities (${rfpCalls} API calls)`);
      allOpportunities.push(...rfpOpps);
      totalApiCalls += rfpCalls;
    }

    // Step 1c: Fetch from BidPrime via public REST API (if enabled)
    if (opts.bidprime) {
      const bidPrimeToken = process.env[ENV_VARS.bidPrimeApiToken];
      if (!bidPrimeToken) {
        console.error(
          pc.red(
            `Error: --bidprime requires ${ENV_VARS.bidPrimeApiToken} in env`,
          ),
        );
        process.exit(1);
      }
      console.log(pc.dim("\n  [BidPrime API]"));
      const bpClient = new BidPrimeClient({ apiToken: bidPrimeToken });
      const { opportunities: bpOpps, apiCallsUsed: bpCalls, total: bpTotal } =
        await bpClient.fetchAllNotifications();
      console.log(
        `  BidPrime: ${bpOpps.length} of ${bpTotal} notifications inbox bids (${bpCalls} API calls)`,
      );
      allOpportunities.push(...bpOpps);
      totalApiCalls += bpCalls;
    }

    // Step 1d: Fetch from BidPrime via session cookie (if enabled)
    if (opts.bidprimeSession) {
      if (!opts.bidprimeUserId) {
        console.error(
          pc.red(
            "Error: --bidprime-session requires --bidprime-user-id <numeric>. " +
              "Find it in /api/v2/alerts/list under any alert's userIds[].",
          ),
        );
        process.exit(1);
      }
      console.log(pc.dim("\n  [BidPrime session]"));
      const session = await loadBidPrimeSession(opts.bidprimeSessionFile);
      const bpsClient = new BidPrimeSessionClient({
        session,
        userId: parseInt(opts.bidprimeUserId, 10),
      });
      const maxBids = opts.bidprimeMax
        ? parseInt(opts.bidprimeMax, 10)
        : undefined;
      const { opportunities: bpsOpps, apiCallsUsed: bpsCalls, total: bpsTotal } =
        await bpsClient.fetchAllNotifications({
          maxBids,
          enrichDetail: !!opts.bidprimeEnrich,
          onProgress: (done, total) => {
            process.stdout.write(
              `\r  Progress: ${done}/${total} (${Math.round((done / total) * 100)}%)`,
            );
          },
        });
      console.log("");
      console.log(
        `  BidPrime session: ${bpsOpps.length} of ${bpsTotal} notifications inbox bids (${bpsCalls} requests)`,
      );
      allOpportunities.push(...bpsOpps);
      totalApiCalls += bpsCalls;
    }

    // Step 2: Dedup (within source by ID, then across sources by title)
    const dedupedById = deduplicateByOpportunityId(allOpportunities);
    const { deduped, duplicatesRemoved } = (opts.rfpmart || opts.bidprime || opts.bidprimeSession)
      ? crossSourceDedup(dedupedById)
      : { deduped: dedupedById, duplicatesRemoved: 0 };

    console.log(`\n  Total raw: ${allOpportunities.length}`);
    console.log(`  After ID dedup: ${dedupedById.length}`);
    if (duplicatesRemoved > 0) {
      console.log(`  Cross-source duplicates removed: ${pc.yellow(String(duplicatesRemoved))}`);
    }
    console.log(`  Unique opportunities: ${deduped.length}`);

    // Step 3: Hard filter
    const filterConfig = broad
      ? { valueRange: { min: 50_000, max: 2_000_000 } }
      : undefined;
    const { kept, dropped } = applyHardFilters(deduped, filterConfig);
    console.log(`  After hard filter: ${kept.length} kept, ${dropped.length} dropped`);

    // Step 4: Score
    console.log(pc.bold(`\nStep 2: Scoring ${kept.length} opportunities with Claude...`));
    const scored = await scoreBatch(kept, {
      apiKey: claudeKey,
      onProgress: (done, total) => {
        process.stdout.write(
          `\r  Progress: ${done}/${total} (${Math.round((done / total) * 100)}%)`,
        );
      },
    });
    console.log("");

    const minScore = parseInt(opts.minScore, 10);
    const aboveThreshold = scored.filter((o) => o.score >= minScore);

    const result: PipelineResult = {
      scored,
      dropped,
      stats: {
        totalFetched: allOpportunities.length,
        afterDedup: deduped.length,
        afterHardFilter: kept.length,
        scored: scored.length,
        aboveThreshold: aboveThreshold.length,
        apiCallsUsed: totalApiCalls,
        claudeCallsUsed: scored.length,
      },
      runDate: new Date().toISOString(),
    };

    // Save outputs
    const dataDir = getStateDir();
    await mkdir(dataDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const fmt = opts.outputFormat;

    if (fmt === "json" || fmt === "both") {
      const jsonFile = join(dataDir, `scored-${dateStr}.json`);
      await writeJson(result, jsonFile);
      console.log(pc.green(`\nJSON saved to ${jsonFile}`));
    }

    if (fmt === "csv" || fmt === "both") {
      const csvFile = join(dataDir, `scored-${dateStr}.csv`);
      await writeCsv(scored, csvFile);
      console.log(pc.green(`CSV saved to ${csvFile}`));
    }

    // Update state
    state.lastRunDate = new Date().toISOString();
    state.monthlyApiCallsUsed += totalApiCalls;
    if (allOpportunities.length > 0) {
      const latestCapture = allOpportunities
        .filter((o: NormalizedOpportunity) => o.capturedDate)
        .sort(
          (a: NormalizedOpportunity, b: NormalizedOpportunity) =>
            new Date(b.capturedDate!).getTime() -
            new Date(a.capturedDate!).getTime(),
        )[0]?.capturedDate;
      if (latestCapture) state.lastCapturedDate = latestCapture;
    }
    await saveState(state);

    printSummary(result);
    console.log(
      pc.dim(
        `To push qualified opportunities to HubSpot, run: govbids push --min-score ${minScore}`,
      ),
    );
  });

// ── enrich ─────────────────────────────────────────────────────────
program
  .command("enrich")
  .description("Tier-2 scoring: download PDFs for top scorers and re-score with full RFP document text")
  .option("--file <path>", "Path to scored opportunities JSON")
  .option("--min-score <n>", "Only enrich bids at or above this score", String(DEFAULT_MIN_SCORE))
  .option("--max <n>", "Cap on bids to enrich (for testing)")
  .option(
    "--claude-key <key>",
    "Anthropic API key",
    process.env[ENV_VARS.claudeApiKey],
  )
  .option("--bidprime-session-file <path>", "Path to BidPrime session cookie file", ".bidprime-session")
  .option("--throttle-ms <n>", "Delay between PDF downloads (ms)", "1500")
  .action(async (opts) => {
    const claudeKey = opts.claudeKey;
    if (!claudeKey) {
      console.error(pc.red(`Error: Set ${ENV_VARS.claudeApiKey} or use --claude-key`));
      process.exit(1);
    }

    const dataDir = getStateDir();
    const inputFile =
      opts.file ?? join(dataDir, `scored-${new Date().toISOString().slice(0, 10)}.json`);

    console.log(pc.bold(`Enriching from ${inputFile}...`));
    const raw = await readFile(inputFile, "utf-8");
    const data = JSON.parse(raw) as PipelineResult;

    const minScore = parseInt(opts.minScore, 10);
    const candidates = data.scored.filter((o) => o.score >= minScore);
    const toEnrich = opts.max ? candidates.slice(0, parseInt(opts.max, 10)) : candidates;

    const bpBids = toEnrich.filter((o) => o.id.startsWith("bidprime-"));
    const otherBids = toEnrich.filter((o) => !o.id.startsWith("bidprime-"));
    if (otherBids.length > 0) {
      console.log(
        pc.yellow(
          `  Skipping ${otherBids.length} non-BidPrime bids (PDF fetch only wired for BidPrime)`,
        ),
      );
    }

    if (bpBids.length === 0) {
      console.log(pc.yellow("No BidPrime bids to enrich."));
      return;
    }

    const session = await loadBidPrimeSession(opts.bidprimeSessionFile);
    const bpsClient = new BidPrimeSessionClient({ session, userId: 0 });
    const throttle = parseInt(opts.throttleMs, 10);

    console.log(`  Downloading + parsing PDFs for ${bpBids.length} bids...`);
    const enrichedById = new Map<string, ScoredOpportunity>();
    let pdfFailures = 0;
    let totalChars = 0;

    for (let i = 0; i < bpBids.length; i++) {
      const opp = bpBids[i];
      const bpId = opp.id.replace(/^bidprime-/, "");
      process.stdout.write(`\r  PDF ${i + 1}/${bpBids.length}  `);

      let documentText = "";
      try {
        const { bytes, contentType } = await bpsClient.downloadDocuments(bpId);
        const result = await extractDocuments(bytes, contentType, `${bpId}.pdf`);
        documentText = result.documents.map((d) => `--- ${d.filename} ---\n${d.text}`).join("\n\n");
        totalChars += result.totalChars;
        if (result.failures.length > 0) pdfFailures += result.failures.length;
      } catch (error) {
        pdfFailures++;
        console.log(pc.red(`\n  PDF download failed for ${bpId}: ${error instanceof Error ? error.message : String(error)}`));
      }

      if (documentText.length > 0) {
        try {
          const rescored = await scoreOpportunityWithDocument(opp, documentText, {
            apiKey: claudeKey,
          });
          enrichedById.set(opp.id, rescored);
        } catch (error) {
          console.log(pc.red(`\n  Rescore failed for ${opp.id}: ${error instanceof Error ? error.message : String(error)}`));
          enrichedById.set(opp.id, opp);
        }
      } else {
        enrichedById.set(opp.id, opp);
      }

      if (i < bpBids.length - 1 && throttle > 0) {
        await new Promise((r) => setTimeout(r, throttle));
      }
    }
    console.log("");
    console.log(`  Enriched ${enrichedById.size} bids; PDF failures: ${pdfFailures}; total doc chars: ${totalChars.toLocaleString()}`);

    const enrichedScored: ScoredOpportunity[] = data.scored.map((o) => enrichedById.get(o.id) ?? o);
    enrichedScored.sort((a, b) => b.score - a.score);

    const dateStr = new Date().toISOString().slice(0, 10);
    const enrichedJson = join(dataDir, `enriched-${dateStr}.json`);
    const enrichedCsv = join(dataDir, `enriched-${dateStr}.csv`);
    const qualifiedCsv = join(dataDir, `qualified-enriched-${dateStr}.csv`);

    const result: PipelineResult = {
      scored: enrichedScored,
      dropped: data.dropped,
      stats: {
        ...data.stats,
        scored: enrichedScored.length,
        aboveThreshold: enrichedScored.filter((o) => o.score >= minScore).length,
      },
      runDate: new Date().toISOString(),
    };

    await writeJson(result, enrichedJson);
    await writeCsv(enrichedScored, enrichedCsv);
    const strict = enrichedScored.filter(
      (o) => o.score >= minScore && (!o.disqualifiers || o.disqualifiers.length === 0),
    );
    await writeCsv(strict, qualifiedCsv);

    console.log(pc.green(`\nJSON saved to ${enrichedJson}`));
    console.log(pc.green(`Enriched CSV saved to ${enrichedCsv}`));
    console.log(pc.green(`Strict-qualified CSV (${strict.length} rows) saved to ${qualifiedCsv}`));

    printSummary(result);
  });

// ── quota ──────────────────────────────────────────────────────────
program
  .command("quota")
  .description("Show current HigherGov API quota usage")
  .action(async () => {
    const state = await loadState();
    printQuota(
      state.monthlyApiCallsUsed,
      MONTHLY_API_QUOTA,
      state.monthlyApiCallsResetDate,
    );
  });

program.parse();
