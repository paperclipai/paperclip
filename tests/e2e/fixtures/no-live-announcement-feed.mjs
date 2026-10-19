// The e2e server must never reach Paperclip's live announcement feed.
// A live announcement's well once covered the chat composer and failed a click
// in CI. playwright.config.ts turns announcements off; this guard catches a
// regression. Any name lookup of the feed's host is recorded in
// PAPERCLIP_E2E_LIVE_FEED_LOG and refused, and global-teardown.ts fails the run
// when the log holds a record. Every request the server makes resolves its host
// through node:dns (the remote HTTP guard's lookup and platform fetch alike).
// The guard also records that it is installed, in a marker beside the log, and
// global-teardown.ts fails the run when no process installed it: an empty log
// then proves nothing.
import dns from "node:dns";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const FEED_HOST = "pages.paperclip.ing";
// Must equal LIVE_FEED_MARKER_NAME in live-feed-log.ts (a .mjs preload cannot import it).
const MARKER_NAME = "live-announcement-feed-guard.active";
const log = process.env.PAPERCLIP_E2E_LIVE_FEED_LOG;

if (process.env.NODE_ENV === "test" && log) {
  const isFeedHost = (hostname) =>
    typeof hostname === "string" &&
    hostname.toLowerCase().replace(/\.$/, "") === FEED_HOST;
  const refuse = (hostname) => {
    fs.appendFileSync(log, `${new Date().toISOString()} ${hostname}\n`);
    return Object.assign(
      new Error(`e2e: the live announcement feed host ${hostname} must not be reached`),
      { code: "ENOTFOUND", hostname },
    );
  };

  const lookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, options, callback) {
    if (!isFeedHost(hostname)) return lookup.apply(this, arguments);
    const done = typeof options === "function" ? options : callback;
    process.nextTick(done, refuse(hostname));
    return {};
  };
  const promisesLookup = dns.promises.lookup;
  dns.promises.lookup = async function guardedPromisesLookup(hostname, ...rest) {
    if (isFeedHost(hostname)) throw refuse(hostname);
    return promisesLookup.call(this, hostname, ...rest);
  };
  // ESM named imports of node:dns and node:dns/promises are bound when first
  // loaded; sync them so `import { lookup } from "node:dns/promises"` sees the guard.
  syncBuiltinESMExports();
  // Published once both lookups are guarded, naming the functions now in place,
  // so a record proves the hooks are installed rather than that this file ran.
  fs.appendFileSync(
    path.join(path.dirname(log), MARKER_NAME),
    `${new Date().toISOString()} ${process.pid} ${dns.lookup.name} ${dns.promises.lookup.name}\n`,
  );
}
