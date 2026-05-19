/**
 * @fileoverview Cert-pin aggregate telemetry route
 *
 * Exposes a snapshot of cert-pin mismatch/handshake counts so that agent
 * workspaces can self-serve the 14-day aggregate without direct relay DNS
 * access (required for CLI-149 / CLI-55 per-host enforcement gate).
 *
 * Snapshot source (in priority order):
 *   1. CERT_PIN_AGGREGATE_FILE env var
 *   2. <instanceDataDir>/cert-pin-aggregate/latest.json
 *
 * @module server/routes/cert-pin-aggregate
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Router } from "express";
import { assertAuthenticated } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

export interface CertPinAggregateEntry {
  hostname: string;
  release_channel: string;
  window: string;
  mismatch_count: number;
  handshake_count: number;
  freshness: string;
}

export interface CertPinAggregateSnapshot {
  entries: CertPinAggregateEntry[];
  generated_at: string;
}

function resolveSnapshotPath(instanceId: string): string {
  if (process.env.CERT_PIN_AGGREGATE_FILE) {
    return process.env.CERT_PIN_AGGREGATE_FILE;
  }
  return path.join(
    os.homedir(),
    ".paperclip",
    "instances",
    instanceId,
    "data",
    "cert-pin-aggregate",
    "latest.json",
  );
}

function readSnapshot(snapshotPath: string): CertPinAggregateSnapshot | null {
  try {
    const raw = fs.readFileSync(snapshotPath, "utf-8");
    return JSON.parse(raw) as CertPinAggregateSnapshot;
  } catch {
    return null;
  }
}

export function certPinAggregateRoutes(opts: { instanceId: string }) {
  const router = Router();

  router.get("/telemetry/cert-pin-aggregate", (req, res) => {
    assertAuthenticated(req);

    const hostname = req.query.hostname as string | undefined;
    const release_channel = req.query.release_channel as string | undefined;

    if (!hostname) {
      throw badRequest("'hostname' query parameter is required");
    }
    if (!release_channel) {
      throw badRequest("'release_channel' query parameter is required");
    }

    const snapshotPath = resolveSnapshotPath(opts.instanceId);
    const snapshot = readSnapshot(snapshotPath);

    if (!snapshot) {
      throw notFound(
        `Cert-pin aggregate snapshot not found at ${snapshotPath}. ` +
          "Populate the snapshot file or set CERT_PIN_AGGREGATE_FILE.",
      );
    }

    const match = snapshot.entries.find(
      (e) => e.hostname === hostname && e.release_channel === release_channel,
    );

    if (!match) {
      throw notFound(
        `No cert-pin aggregate entry found for hostname=${hostname} release_channel=${release_channel}.`,
      );
    }

    res.json({
      hostname: match.hostname,
      release_channel: match.release_channel,
      window: match.window,
      mismatch_count: match.mismatch_count,
      handshake_count: match.handshake_count,
      freshness: snapshot.generated_at,
    });
  });

  return router;
}
