import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { forbidden } from "../errors.js";

interface ServiceStatus {
  name: string;
  status: "healthy" | "unhealthy";
  responseTimeMs: number;
}

async function checkHttp(name: string, url: string): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const responseTimeMs = Date.now() - start;
    return { name, status: res.ok ? "healthy" : "unhealthy", responseTimeMs };
  } catch {
    return { name, status: "unhealthy", responseTimeMs: Date.now() - start };
  }
}

export function systemStatusRoutes(db: Db) {
  const router = Router();

  router.get("/", async (req, res) => {
    if (req.actor.type === "none") {
      throw forbidden();
    }

    const [postgres, vllm, deerflowLanggraph, deerflowGateway] = await Promise.all([
      (async (): Promise<ServiceStatus> => {
        const start = Date.now();
        try {
          await db.execute(sql`SELECT 1`);
          return { name: "PostgreSQL", status: "healthy", responseTimeMs: Date.now() - start };
        } catch {
          return { name: "PostgreSQL", status: "unhealthy", responseTimeMs: Date.now() - start };
        }
      })(),
      checkHttp("vLLM", "http://host.docker.internal:8000/v1/models"),
      checkHttp("DeerFlow LangGraph", "http://deerflow-langgraph:2024/ok"),
      checkHttp("DeerFlow Gateway", "http://deerflow-gateway:8001/health"),
    ]);

    res.json([postgres, vllm, deerflowLanggraph, deerflowGateway]);
  });

  return router;
}
