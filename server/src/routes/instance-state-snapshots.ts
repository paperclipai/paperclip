import { Router } from "express";
import { assertInstanceAdmin } from "./authz.js";
import type { InstanceStateSnapshotResult } from "../services/instance-state-snapshot.js";

export type InstanceStateSnapshotService = {
  runSnapshot(): Promise<InstanceStateSnapshotResult>;
  restoreSnapshot(objectKey: string): Promise<void>;
};

export function instanceStateSnapshotRoutes(service: InstanceStateSnapshotService) {
  const router = Router();
  router.post("/instance/state-snapshots", async (req, res) => {
    assertInstanceAdmin(req);
    res.status(201).json(await service.runSnapshot());
  });
  router.post("/instance/state-snapshots/restore", async (req, res) => {
    assertInstanceAdmin(req);
    const objectKey = typeof req.body?.objectKey === "string" ? req.body.objectKey.trim() : "";
    if (!objectKey) return res.status(400).json({ error: "objectKey is required" });
    await service.restoreSnapshot(objectKey);
    res.status(200).json({ restored: true, objectKey });
  });
  return router;
}
