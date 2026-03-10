import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { previewAgentRuntimeRestore, restoreAgentRuntimeFromS3 } from "../services/index.js";
import { assertBoard } from "./authz.js";

const restoreBodySchema = z.object({
  strategy: z.enum(["missing_only", "overwrite_all", "selected"]).default("missing_only"),
  selectedKeys: z.array(z.string()).optional(),
});

export function agentRuntimeRoutes() {
  const router = Router();

  /**
   * GET /api/agent-runtime/restore/preview
   *
   * Returns a diff of what a restore from S3 would do:
   * - missing: files in S3 not present locally (will be restored)
   * - conflicts: files in both S3 and local with different content (user must choose)
   * - synced: files identical in both places
   */
  router.get("/agent-runtime/restore/preview", async (req, res, next) => {
    try {
      assertBoard(req);
      const preview = await previewAgentRuntimeRestore();
      res.json(preview);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/agent-runtime/restore
   *
   * Trigger a restore from S3. Body:
   *   strategy: "missing_only" | "overwrite_all" | "selected"
   *   selectedKeys?: string[]  — objectKeys to overwrite (strategy="selected" only)
   *
   * missing_only  — safe default: only write files absent locally (idempotent)
   * overwrite_all — restore everything, overwriting local with S3
   * selected      — overwrite only the specified objectKeys
   */
  router.post(
    "/agent-runtime/restore",
    validate(restoreBodySchema),
    async (req, res, next) => {
      try {
        assertBoard(req);
        const { strategy, selectedKeys } = req.body as z.infer<typeof restoreBodySchema>;
        const result = await restoreAgentRuntimeFromS3({ strategy, selectedKeys });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
