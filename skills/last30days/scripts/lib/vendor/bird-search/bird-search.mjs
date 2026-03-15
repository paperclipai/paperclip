#!/usr/bin/env node
/**
 * bird-search.mjs - Vendored Bird CLI search wrapper for /last30days.
 * Subset of @steipete/bird v0.8.0 (MIT License, Peter Steinberger).
 *
 * Usage:
 *   node bird-search.mjs <query> [--count N] [--json]
 *   node bird-search.mjs --whoami
 *   node bird-search.mjs --check
 */

import { resolveCredentials } from './lib/cookies.js';
import { TwitterClientBase } from './lib/twitter-client-base.js';
import { withSearch } from './lib/twitter-client-search.js';

// Build a search-only client (no posting, bookmarks, etc.)
const SearchClient = withSearch(TwitterClientBase);

const args = process.argv.slice(2);

// --check: verify that credentials can be resolved
if (args.includes('--check')) {
  try {
    const { cookies, warnings } = await resolveCredentials({});
    if (cookies.authToken && cookies.ct0) {
      process.stdout.write(JSON.stringify({ authenticated: true, source: cookies.source }));
      process.exit(0);
    } else {
      process.stdout.write(JSON.stringify({ authenticated: false, warnings }));
      process.exit(1);
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({ authenticated: false, error: err.message }));
    process.exit(1);
  }
}

// --whoami: check auth and output source
if (args.includes('--whoami')) {
  try {
    const { cookies } = await resolveCredentials({});
    if (cookies.authToken && cookies.ct0) {
      process.stdout.write(cookies.source || 'authenticated');
      process.exit(0);
    } else {
      process.stderr.write('Not authenticated\n');
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`Auth check failed: ${err.message}\n`);
    process.exit(1);
  }
}

// Parse search args
let query = null;
let count = 20;
let jsonOutput = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--count' && args[i + 1]) {
    count = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '-n' && args[i + 1]) {
    count = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--json') {
    jsonOutput = true;
  } else if (!args[i].startsWith('-')) {
    query = args[i];
  }
}

if (!query) {
  process.stderr.write('Usage: node bird-search.mjs <query> [--count N] [--json]\n');
  process.exit(1);
}

try {
  // Resolve credentials (env vars, then browser cookies)
  const { cookies, warnings } = await resolveCredentials({});

  if (!cookies.authToken || !cookies.ct0) {
    const msg = warnings.length > 0 ? warnings.join('; ') : 'No Twitter credentials found';
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ error: msg, items: [] }));
    } else {
      process.stderr.write(`Error: ${msg}\n`);
    }
    process.exit(1);
  }

  // Create search client
  const client = new SearchClient({
    cookies: {
      authToken: cookies.authToken,
      ct0: cookies.ct0,
      cookieHeader: cookies.cookieHeader,
    },
    timeoutMs: 30000,
  });

  // Run search
  const result = await client.search(query, count);

  if (!result.success) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ error: result.error, items: [] }));
    } else {
      process.stderr.write(`Search failed: ${result.error}\n`);
    }
    process.exit(1);
  }

  // Output results
  const tweets = result.tweets || [];
  if (jsonOutput) {
    process.stdout.write(JSON.stringify(tweets));
  } else {
    for (const tweet of tweets) {
      const author = tweet.author?.username || 'unknown';
      process.stdout.write(`@${author}: ${tweet.text?.slice(0, 200)}\n\n`);
    }
  }

  process.exit(0);
} catch (err) {
  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ error: err.message, items: [] }));
  } else {
    process.stderr.write(`Error: ${err.message}\n`);
  }
  process.exit(1);
}
