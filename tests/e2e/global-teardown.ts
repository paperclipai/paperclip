import fs from "node:fs";
import { LIVE_FEED_MARKER_RECORD, liveFeedLogPath, liveFeedMarkerPath } from "./fixtures/live-feed-log.ts";

// One record of fixtures/no-live-announcement-feed.mjs: an ISO timestamp and a hostname.
const RECORD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z [A-Za-z0-9.-]+$/;

// Fails the run when the e2e server tried to reach the live announcement feed:
// fixtures/no-live-announcement-feed.mjs records every such lookup.
// It fails closed: without the config's log path, or without the marker the
// guard writes when it installs, an empty log would prove nothing.
export default async function assertNoLiveAnnouncementFeed() {
  const log = liveFeedLogPath(process.env.PAPERCLIP_E2E_LIVE_FEED_LOG);
  if (!log) {
    throw new Error("The live-feed guard's log path is missing or not one playwright.config.ts creates.");
  }
  const marker = liveFeedMarkerPath(log);
  const installed = fs.existsSync(marker) && fs.readFileSync(marker, "utf8").split("\n").some((line) => LIVE_FEED_MARKER_RECORD.test(line));
  if (!installed) {
    throw new Error("The live-feed guard never installed in the e2e server, so this run cannot show the feed was not reached.");
  }
  if (!fs.existsSync(log)) return;
  const lines = fs.readFileSync(log, "utf8").split("\n").filter((line) => line.trim());
  if (lines.length === 0) return;
  // The error quotes only the guard's own records, never other content of the file.
  const records = lines.filter((line) => RECORD.test(line)).slice(0, 20);
  throw new Error(
    `The e2e server tried to reach the live announcement feed (${lines.length} line(s) in the guard log); announcements must stay off in e2e:\n${records.join("\n")}`,
  );
}
