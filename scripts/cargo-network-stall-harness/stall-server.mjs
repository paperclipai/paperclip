#!/usr/bin/env node
// A local stand-in for a cargo sparse registry. It serves one synthetic
// crate and holds the download response body empty for a fixed period
// before it sends the full body. This copies a real network stall: the
// transfer rate stays at 0 bytes per second until the stall period ends.
import http from "node:http";
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    args[key] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const requestedPort = Number(args.port ?? 0);
const crateName = args["crate-name"];
const crateVersion = args["crate-version"];
const cksum = args.cksum;
const stallSeconds = Number(args["stall-seconds"]);
const tarball = readFileSync(args.tarball);

if (!crateName || !crateVersion || !cksum || !Number.isFinite(stallSeconds) || !args.tarball) {
  console.error(
    "usage: stall-server.mjs --port <n> --crate-name <name> --crate-version <ver> --cksum <hex> --stall-seconds <n> --tarball <path>",
  );
  process.exit(1);
}

// Cargo's sparse registry protocol picks the index path from the crate
// name length. See the cargo book, "Index Format", for this rule.
function indexPathSegment(name) {
  if (name.length <= 2) return `${name.length}/${name}`;
  if (name.length === 3) return `3/${name[0]}/${name}`;
  return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
}

const indexSegment = indexPathSegment(crateName);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const port = server.address().port;

  if (url.pathname === "/index/config.json") {
    const body = JSON.stringify({
      dl: `http://127.0.0.1:${port}/dl`,
      api: `http://127.0.0.1:${port}`,
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (url.pathname === `/index/${indexSegment}`) {
    const body = `${JSON.stringify({
      name: crateName,
      vers: crateVersion,
      deps: [],
      cksum,
      features: {},
      yanked: false,
    })}\n`;
    res.writeHead(200, {
      "content-type": "text/plain",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (url.pathname === `/dl/${crateName}/${crateVersion}/download`) {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": tarball.length,
    });
    res.flushHeaders();
    // Hold the body empty for the stall period, then send it all at once.
    // This puts the transfer rate at 0 bytes/sec until the stall ends.
    setTimeout(() => {
      res.end(tarball);
    }, stallSeconds * 1000);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(requestedPort, "127.0.0.1", () => {
  console.log(`LISTENING ${server.address().port}`);
});
