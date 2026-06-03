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
import { loadSeenStore, saveSeenStore, filterSeen, markSeen } from "./seen-set.js";
import { isAddendumOrRepost, isQandA } from "../core/addendum.js";
import { writeJson, writeCsv, writeLawyerCsv, writeLawyerXlsx, writeQualifiedCsv, printSummary, printQuota } from "./output.js";
import { SlackClient } from "../core/slack-client.js";

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

// ── daily ──────────────────────────────────────────────────────────
program
  .command("daily")
  .description(
    "Daily pipeline: fetch + score + write lawyer-friendly CSV + post to Slack",
  )
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
  .option("--min-score <n>", "Minimum qualifying score", String(DEFAULT_MIN_SCORE))
  .option("--max-records <n>", "Max records per source", "1000")
  .option(
    "--lookback-days <n>",
    "Fixed rolling window for HigherGov captured_date (decoupled from incremental state; seen-set dedupes repeats)",
    process.env.GOVBIDS_LOOKBACK_DAYS ?? "7",
  )
  .option("--no-rfpmart", "Skip RFPMart source")
  .option("--no-highergov", "Skip HigherGov source")
  .option(
    "--bidprime-session",
    "Force-include BidPrime via session cookie (auto-enabled when BIDPRIME_USER_ID + BIDPRIME_SESSION_FILE env vars are set)",
  )
  .option(
    "--no-bidprime",
    "Force-skip BidPrime even if env vars are set",
  )
  .option(
    "--bidprime-session-file <path>",
    "Path to BidPrime session cookie file",
    process.env[ENV_VARS.bidPrimeSessionFile] ?? ".bidprime-session",
  )
  .option(
    "--bidprime-user-id <n>",
    "BidPrime numeric userId",
    process.env[ENV_VARS.bidPrimeUserId],
  )
  .option(
    "--slack-token <token>",
    "Slack bot token",
    process.env[ENV_VARS.slackBotToken],
  )
  .option(
    "--slack-channel <name-or-id>",
    "Slack channel name or ID",
    process.env[ENV_VARS.slackChannel],
  )
  .option(
    "--slack-channel-id <id>",
    "Slack channel ID (for file uploads — needed when bot lacks channels:read scope)",
    process.env[ENV_VARS.slackChannelId],
  )
  .option("--no-notify", "Skip Slack post — useful for local testing")
  .option(
    "--include-seen",
    "Include opportunities already shown in prior daily runs (default: skip; with day-of-deadline + 3-day due-date drift exceptions)",
  )
  .option(
    "--only-if-needed",
    "Skip silently if state.lastRunDate is already today (used by the 8 AM recovery launchd job; harmless to call manually)",
  )
  .action(async (opts) => {
    // --only-if-needed: if a successful run already happened today, exit silently.
    // Used by the 8 AM recovery launchd job — it's a no-op when 7 AM succeeded
    // and recovers automatically when 7 AM failed.
    let isRecoveryRun = false;
    let lastRunIso: string | null = null;
    if (opts.onlyIfNeeded) {
      const stateNow = await loadState();
      lastRunIso = stateNow.lastRunDate;
      if (lastRunIso) {
        const last = new Date(lastRunIso);
        const now = new Date();
        const sameLocalDay =
          last.toLocaleDateString() === now.toLocaleDateString();
        if (sameLocalDay) {
          const hours = Math.round((now.getTime() - last.getTime()) / 36e5);
          console.log(
            pc.dim(
              `--only-if-needed: last successful run was today (${last.toLocaleTimeString()}, ${hours}h ago). Skipping.`,
            ),
          );
          return;
        }
        const hoursOld = (now.getTime() - last.getTime()) / 36e5;
        console.log(
          pc.yellow(
            `--only-if-needed: last successful run was ${hoursOld.toFixed(1)}h ago (${last.toLocaleString()}). Running RECOVERY.`,
          ),
        );
      } else {
        console.log(
          pc.yellow(`--only-if-needed: no prior successful run recorded. Running RECOVERY.`),
        );
      }
      isRecoveryRun = true;
    }

    const claudeKey = opts.claudeKey;
    if (!claudeKey) {
      console.error(
        pc.red(`Error: Set ${ENV_VARS.claudeApiKey} or use --claude-key`),
      );
      process.exit(1);
    }

    const higherGovKey = opts.highergovKey;
    const useHigherGov = opts.highergov !== false && !!higherGovKey;
    const useRfpMart = opts.rfpmart !== false;
    // BidPrime: enabled if user passed --bidprime-session explicitly, OR if both env vars are set
    // and --no-bidprime wasn't passed.
    const bidPrimeEnvReady = !!(opts.bidprimeUserId && opts.bidprimeSessionFile);
    const useBidPrime =
      opts.bidprime === false
        ? false
        : !!opts.bidprimeSession || bidPrimeEnvReady;

    if (!useHigherGov && !useRfpMart && !useBidPrime) {
      console.error(
        pc.red(
          "Error: No sources enabled. Set HIGHERGOV_API_KEY, or pass --rfpmart, or pass --bidprime-session.",
        ),
      );
      process.exit(1);
    }

    if (opts.highergov !== false && !higherGovKey) {
      console.log(
        pc.yellow(
          "  Warning: HIGHERGOV_API_KEY not set — skipping HigherGov source.",
        ),
      );
    }

    const minScore = parseInt(opts.minScore, 10);
    const state = await loadState();
    // Fixed rolling window instead of an incremental high-water-mark. The old
    // `since = state.lastCapturedDate` was a MAX across all sources; BidPrime's
    // capturedDate = agency issueDate (often "today"), which poisoned the
    // HigherGov floor and caused late-captured RFPs to be skipped. Re-scanning
    // a fixed N-day window every run + the seen-set (which dedupes repeats)
    // guarantees a late-captured RFP is picked up within 1 day of ingestion.
    const lookbackDays = Math.max(1, parseInt(opts.lookbackDays, 10) || 7);
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - lookbackDays);
    const since = sinceDate.toISOString().slice(0, 10);

    console.log(pc.bold("Step 1: Fetching opportunities..."));
    console.log(`  HigherGov captured-date window: last ${lookbackDays} days (since ${since})`);
    console.log(
      `  Sources: ${[
        useHigherGov && "HigherGov",
        useRfpMart && "RFPMart",
        useBidPrime && "BidPrime (session)",
      ]
        .filter(Boolean)
        .join(", ")}`,
    );

    let allOpportunities: NormalizedOpportunity[] = [];
    let totalApiCalls = 0;
    const sourceCounts: Record<string, number> = {};
    // Per-source failure log: surfaces in the Slack post so a silent dead source
    // is visible instead of hidden. Pipeline keeps running with remaining sources.
    const sourceFailures: Record<string, string> = {};

    if (useHigherGov) {
      console.log(pc.dim("\n  [HigherGov]"));
      try {
        const hgClient = new HigherGovClient({ apiKey: higherGovKey });
        const { opportunities: hgOpps, apiCallsUsed: hgCalls } =
          await hgClient.fetchAllKeywordSearches({
            capturedAfter: since,
            maxRecords: parseInt(opts.maxRecords, 10),
          });
        console.log(`  HigherGov: ${hgOpps.length} opportunities (${hgCalls} API calls)`);
        allOpportunities.push(...hgOpps);
        totalApiCalls += hgCalls;
        sourceCounts.HigherGov = hgOpps.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const cause =
          err instanceof Error && (err as { cause?: { code?: string } }).cause?.code
            ? ` (${(err as { cause?: { code?: string } }).cause!.code})`
            : "";
        console.log(pc.red(`  HigherGov FAILED: ${msg}${cause} — continuing with other sources`));
        sourceFailures.HigherGov = `${msg}${cause}`;
        sourceCounts.HigherGov = 0;
      }
    }

    if (useRfpMart) {
      console.log(pc.dim("\n  [RFPMart]"));
      try {
        const rfpClient = new RfpMartClient({ customerId: RFPMART_CUSTOMER_ID });
        const { opportunities: rfpOpps, apiCallsUsed: rfpCalls } =
          await rfpClient.fetchRecentDays(7);
        console.log(`  RFPMart: ${rfpOpps.length} opportunities (${rfpCalls} API calls)`);
        allOpportunities.push(...rfpOpps);
        totalApiCalls += rfpCalls;
        sourceCounts.RFPMart = rfpOpps.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(pc.red(`  RFPMart FAILED: ${msg} — continuing with other sources`));
        sourceFailures.RFPMart = msg;
        sourceCounts.RFPMart = 0;
      }
    }

    if (useBidPrime) {
      if (!opts.bidprimeUserId) {
        console.error(
          pc.red(
            "Error: --bidprime-session requires --bidprime-user-id <numeric>",
          ),
        );
        process.exit(1);
      }
      console.log(pc.dim("\n  [BidPrime session]"));
      try {
        const session = await loadBidPrimeSession(opts.bidprimeSessionFile);
        const bpsClient = new BidPrimeSessionClient({
          session,
          userId: parseInt(opts.bidprimeUserId, 10),
        });
        const { opportunities: bpsOpps, apiCallsUsed: bpsCalls, total: bpsTotal } =
          await bpsClient.fetchAllNotifications({
            onProgress: (done, total) => {
              process.stdout.write(
                `\r  Progress: ${done}/${total} (${Math.round((done / total) * 100)}%)`,
              );
            },
          });
        console.log("");
        console.log(
          `  BidPrime: ${bpsOpps.length} of ${bpsTotal} bids (${bpsCalls} requests)`,
        );
        allOpportunities.push(...bpsOpps);
        totalApiCalls += bpsCalls;
        sourceCounts.BidPrime = bpsOpps.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(pc.red(`  BidPrime FAILED: ${msg} — continuing with other sources`));
        sourceFailures.BidPrime = msg;
        sourceCounts.BidPrime = 0;
      }
    }

    // If ALL sources failed, abort with an error so launchd shows red.
    // (If at least one succeeded, keep going — degraded delivery beats none.)
    const sourcesUsed = [useHigherGov, useRfpMart, useBidPrime].filter(Boolean).length;
    if (sourcesUsed > 0 && Object.keys(sourceFailures).length === sourcesUsed) {
      console.error(
        pc.red(
          `\nALL ${sourcesUsed} sources failed. Likely a network/DNS issue. Re-run when connectivity is restored.`,
        ),
      );
      // Heartbeat alert — try one last Slack post so the team/owner sees the failure.
      // Especially important when this is the 8 AM recovery run failing (no other notification path).
      if (opts.slackToken && (opts.slackChannelId || opts.slackChannel) && opts.notify !== false) {
        try {
          const hbSlack = new SlackClient({ botToken: opts.slackToken });
          const target =
            (process.env.SLACK_DM_USER_ID as string | undefined) ??
            opts.slackChannelId ??
            `#${(opts.slackChannel as string).replace(/^#/, "")}`;
          const failedLines = Object.entries(sourceFailures)
            .map(([s, m]) => `   • *${s}*: ${m}`)
            .join("\n");
          await hbSlack.postMessage({
            channelId: target,
            text: [
              `:rotating_light: *Daily RFP pipeline failed — ALL sources unreachable*`,
              isRecoveryRun
                ? `_Recovery run at ${new Date().toLocaleTimeString()} could not reach any source. The 7 AM job had already failed; this 8 AM retry also failed._`
                : `_${new Date().toLocaleString()} — daily run could not reach any source._`,
              ``,
              `Failed sources:`,
              failedLines,
              ``,
              `Likely causes: laptop offline, VPN issue, DNS down. State files are untouched — re-run \`pnpm govbids:daily\` once connectivity returns.`,
            ].join("\n"),
          });
          console.log(pc.yellow("  Heartbeat alert posted to Slack."));
        } catch (err) {
          console.error(
            pc.red(`  Heartbeat alert also failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }
      }
      process.exit(1);
    }

    const dedupedById = deduplicateByOpportunityId(allOpportunities);
    const { deduped, duplicatesRemoved } =
      useRfpMart || useBidPrime
        ? crossSourceDedup(dedupedById)
        : { deduped: dedupedById, duplicatesRemoved: 0 };
    const { kept, dropped } = applyHardFilters(deduped);
    console.log(
      `\n  Raw: ${allOpportunities.length} → unique: ${deduped.length} → after hard filter: ${kept.length}`,
    );
    if (duplicatesRemoved > 0) {
      console.log(`  Cross-source duplicates removed: ${duplicatesRemoved}`);
    }

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

    // Strict qualified: score >= threshold AND no disqualifiers
    const strictQualifiedAll = scored
      .filter((o) => o.score >= minScore && (!o.disqualifiers || o.disqualifiers.length === 0))
      .sort((a, b) => b.score - a.score);

    // Filter out opportunities already shown to the team in prior daily runs,
    // unless they hit day-of-deadline or due-date drifted by >3 days.
    const seenStore = await loadSeenStore();
    const filtered = filterSeen(strictQualifiedAll, seenStore, {
      includeSeen: !!opts.includeSeen,
    });

    // US-3: 3-way split — Qualified (new) / Addenda & Updates / dropped Q&A.
    //   - Q&A / clarification docs are not biddable → DROPPED entirely.
    //   - Addenda = title looks like an addendum/re-post, OR same solicitation
    //     re-appeared with a new id / mutated title (repost via fingerprint or
    //     agency-similarity), OR an already-shown RFP re-surfaced on a deadline
    //     change (reshownDeadline).
    //   - Everything else fresh = new Qualified RFPs.
    const droppedQandA = filtered.fresh.filter((o) => isQandA(o.title));
    const freshNonQandA = filtered.fresh.filter((o) => !isQandA(o.title));
    const freshCandidates = freshNonQandA.filter(
      (o) => !isAddendumOrRepost(o.title),
    );
    const freshAddenda = freshNonQandA.filter((o) => isAddendumOrRepost(o.title));
    const strictQualified = freshCandidates.sort((a, b) => b.score - a.score);
    // repost/reshown that are actually Q&A should be dropped, not shown as addenda.
    const addenda = [
      ...freshAddenda,
      ...filtered.repost.filter((o) => !isQandA(o.title)),
      ...filtered.reshownDeadline.filter((o) => !isQandA(o.title)),
    ].sort((a, b) => b.score - a.score);

    console.log(
      `  Seen-set filter: ${strictQualified.length} new RFPs · ${addenda.length} addenda/updates (${freshAddenda.length} titled, ${filtered.repost.length} re-post, ${filtered.reshownDeadline.length} deadline) · ${droppedQandA.length} Q&A dropped · ${filtered.suppressed.length} suppressed as repeats`,
    );

    // Mark everything we surfaced (new + addenda) as seen for future runs.
    // Dropped Q&A is intentionally NOT marked — if it ever re-appears as a real
    // amendment we still want to evaluate it.
    markSeen([...strictQualified, ...addenda], seenStore);
    await saveSeenStore(seenStore);

    const result: PipelineResult = {
      scored,
      dropped,
      stats: {
        totalFetched: allOpportunities.length,
        afterDedup: deduped.length,
        afterHardFilter: kept.length,
        scored: scored.length,
        aboveThreshold: strictQualified.length,
        apiCallsUsed: totalApiCalls,
        claudeCallsUsed: scored.length,
      },
      runDate: new Date().toISOString(),
    };

    const dataDir = getStateDir();
    await mkdir(dataDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const dailyDir = join(dataDir, "daily");
    await mkdir(dailyDir, { recursive: true });

    const lawyerXlsx = join(dailyDir, `qualified-${dateStr}-for-team.xlsx`);
    const lawyerCsv = join(dailyDir, `qualified-${dateStr}-for-team.csv`);
    const fullCsv = join(dailyDir, `qualified-${dateStr}-full.csv`);
    const jsonFile = join(dailyDir, `scored-${dateStr}.json`);

    await writeLawyerXlsx(strictQualified, lawyerXlsx, addenda);
    await writeLawyerCsv(strictQualified, lawyerCsv);
    await writeCsv(strictQualified, fullCsv);
    await writeJson(result, jsonFile);

    console.log(pc.green(`\nQualified (Excel — team): ${lawyerXlsx}`));
    console.log(pc.green(`Qualified (CSV — backup): ${lawyerCsv}`));
    console.log(pc.green(`Qualified (full):         ${fullCsv}`));
    console.log(pc.green(`Run record:               ${jsonFile}`));

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

    // Slack post
    if (opts.notify === false) {
      console.log(pc.dim("\n--no-notify: skipping Slack post."));
      return;
    }

    if (!opts.slackToken) {
      console.log(
        pc.yellow(`\nSkipping Slack post — ${ENV_VARS.slackBotToken} not set.`),
      );
      return;
    }
    if (!opts.slackChannel && !opts.slackChannelId) {
      console.log(
        pc.yellow(
          `\nSkipping Slack post — ${ENV_VARS.slackChannel} or SLACK_CHANNEL_ID not set.`,
        ),
      );
      return;
    }

    console.log(pc.bold("\nStep 3: Posting to Slack..."));
    const slack = new SlackClient({ botToken: opts.slackToken });

    // Source-health warnings (also surfaced on quiet days).
    const sourceWarnings: string[] = [];
    // Hard failures (network/auth/cookie/etc) — distinguished from "returned 0"
    if (sourceFailures.HigherGov) {
      sourceWarnings.push(
        `:rotating_light: HigherGov FAILED today (\`${sourceFailures.HigherGov}\`) — likely a transient network issue. The launchd job will retry tomorrow at 7 AM.`,
      );
    } else if (useHigherGov && sourceCounts.HigherGov === 0) {
      sourceWarnings.push(
        ":warning: HigherGov returned 0 bids — verify the API key and quota.",
      );
    }
    if (sourceFailures.RFPMart) {
      sourceWarnings.push(
        `:rotating_light: RFPMart FAILED today (\`${sourceFailures.RFPMart}\`) — investigate.`,
      );
    } else if (useRfpMart && sourceCounts.RFPMart === 0) {
      sourceWarnings.push(
        ":warning: RFPMart returned 0 bids — verify the customer ID.",
      );
    }
    if (sourceFailures.BidPrime) {
      sourceWarnings.push(
        `:rotating_light: BidPrime FAILED today (\`${sourceFailures.BidPrime}\`) — likely the session cookie expired. Refresh \`.bidprime-session\`.`,
      );
    } else if (useBidPrime && sourceCounts.BidPrime === 0) {
      sourceWarnings.push(
        ":rotating_light: BidPrime returned 0 bids — the `.bidprime-session` cookie has likely expired. Refresh it before tomorrow's run.",
      );
    }

    // Quiet-day path: nothing new after the seen-set filter (typical on weekends
    // when government portals don't post). Send a short, friendly text message
    // instead of an empty Excel attachment that would confuse the team.
    if (strictQualified.length === 0 && addenda.length === 0) {
      const day = new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "long",
      });
      const quietLines = [
        isRecoveryRun
          ? `:coffee: *Government RFP daily digest — ${dateStr} (${day}, RECOVERY — 7 AM run missed)*`
          : `:coffee: *Government RFP daily digest — ${dateStr} (${day})*`,
        `No new qualified RFPs today.`,
        filtered.suppressed.length > 0
          ? `_${filtered.suppressed.length} already-sourced RFPs were screened and suppressed as repeats. ${kept.length} total opportunities reviewed._`
          : `_${kept.length} opportunities reviewed; none cleared the bar (score ≥ ${minScore}, no disqualifiers)._`,
        `Government portals post little on weekends/holidays — this is expected. Next digest: tomorrow 7 AM.`,
      ];
      if (sourceWarnings.length) quietLines.push("", ...sourceWarnings);

      try {
        await slack.postMessage({
          channelId:
            opts.slackChannelId ??
            `#${(opts.slackChannel as string).replace(/^#/, "")}`,
          text: quietLines.join("\n"),
        });
        console.log(pc.green("  Posted quiet-day Slack message (no file)."));
      } catch (err) {
        console.error(
          pc.red(
            `  Slack post failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(2);
      }
      return;
    }

    const summaryLines: string[] = [];
    summaryLines.push(
      isRecoveryRun
        ? `:repeat: *Government RFP daily digest — ${dateStr} (RECOVERY — 7 AM run missed)*`
        : `:newspaper: *Government RFP daily digest — ${dateStr}*`,
    );
    if (isRecoveryRun) {
      const lastRunNote = lastRunIso
        ? `_The 7 AM scheduled run didn't complete (last successful: ${new Date(lastRunIso).toLocaleString()}). This 8 AM recovery run picked up the same window._`
        : `_The 7 AM scheduled run didn't complete. This 8 AM recovery run picked up the same window._`;
      summaryLines.push(lastRunNote);
    }
    summaryLines.push(
      `*${strictQualified.length}* new qualified RFPs today (score ≥ ${minScore}, no disqualifiers) from ${kept.length} screened.`,
    );
    if (addenda.length > 0) {
      summaryLines.push(
        `:paperclip: ${addenda.length} addenda/updates (see the "Addenda & Updates" tab — not counted as new RFPs)`,
      );
    }
    if (filtered.suppressed.length > 0) {
      summaryLines.push(
        `_${filtered.suppressed.length} already-sourced RFPs suppressed as repeats._`,
      );
    }

    const sourceSummary = Object.entries(sourceCounts)
      .map(([s, n]) => `${s}: ${n}`)
      .join(" · ");
    if (sourceSummary) summaryLines.push(`Sources: ${sourceSummary}`);

    if (sourceWarnings.length) summaryLines.push("", ...sourceWarnings);

    if (strictQualified.length > 0) {
      summaryLines.push("", "*Top 5 picks:*");
      for (const opp of strictQualified.slice(0, 5)) {
        const dueDate = opp.dueDate
          ? new Date(opp.dueDate).toLocaleDateString("en-US")
          : "no date";
        const value = opp.estimatedValue
          ? `$${(opp.estimatedValue / 1000).toFixed(0)}K`
          : "value TBD";
        const tier = opp.score >= 80 ? ":large_green_circle:" : ":large_yellow_circle:";
        summaryLines.push(
          `${tier} *${opp.score}* — ${opp.title} (${opp.agency}, ${opp.state ?? "—"}) — due ${dueDate}, ${value}`,
        );
      }
    }

    summaryLines.push("", "_Full list attached as an Excel file — tap to open._");

    const initialComment = summaryLines.join("\n");
    const channelNameOrId =
      opts.slackChannelId ?? `#${(opts.slackChannel as string).replace(/^#/, "")}`;

    // Try file upload if we have the channel ID. Fall back to text-only post on any failure
    // (commonly: bot missing files:write scope) so the daily delivery still happens.
    let uploaded = false;
    if (opts.slackChannelId) {
      try {
        await slack.uploadFile({
          channelId: opts.slackChannelId,
          filePath: lawyerXlsx,
          title: `Qualified RFPs — ${dateStr}`,
          initialComment,
        });
        console.log(pc.green(`  Posted to Slack with Excel file attached.`));
        uploaded = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          pc.yellow(`  File upload failed (${msg}). Falling back to text-only post.`),
        );
      }
    }

    if (!uploaded) {
      try {
        // Append the full qualified list as a code block so lawyers see everything inline.
        const tableLines = ["", "```", "Rank | Score | Title — Agency (State) — Due"];
        for (const opp of strictQualified) {
          const idx = strictQualified.indexOf(opp) + 1;
          const dueDate = opp.dueDate
            ? new Date(opp.dueDate).toLocaleDateString("en-US")
            : "—";
          tableLines.push(
            `${String(idx).padStart(2)} | ${String(opp.score).padStart(3)}   | ${opp.title.slice(0, 60)}${opp.title.length > 60 ? "…" : ""} — ${opp.agency} (${opp.state ?? "—"}) — ${dueDate}`,
          );
        }
        tableLines.push("```");
        tableLines.push(`_Full Excel saved locally: \`${lawyerXlsx}\`_`);

        await slack.postMessage({
          channelId: opts.slackChannelId ?? channelNameOrId,
          text: initialComment + tableLines.join("\n"),
        });
        console.log(pc.green("  Posted Slack summary (text-only)."));
      } catch (err) {
        console.error(
          pc.red(
            `  Slack post failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(2);
      }
    }
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
