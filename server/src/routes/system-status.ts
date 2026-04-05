import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { unauthorized } from "../errors.js";

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
      throw unauthorized();
    }

    const vllmUrl = process.env.VLLM_API_URL ?? "http://host.docker.internal:8000/v1";
    const langgraphUrl = process.env.DEERFLOW_LANGGRAPH_URL ?? "http://deerflow-langgraph:2024";
    const gatewayUrl = process.env.DEERFLOW_GATEWAY_URL ?? "http://deerflow-gateway:8001";

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
      checkHttp("vLLM", `${vllmUrl}/models`),
      checkHttp("DeerFlow LangGraph", `${langgraphUrl}/ok`),
      checkHttp("DeerFlow Gateway", `${gatewayUrl}/health`),
    ]);

    res.json([postgres, vllm, deerflowLanggraph, deerflowGateway]);
  });

  return router;
}
