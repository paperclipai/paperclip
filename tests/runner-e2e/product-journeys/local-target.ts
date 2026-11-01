import { createHash } from "node:crypto";
import { parseConnectionConfig } from "../connection-config.js";
import { ConnectionApi, startConnectionTarget } from "../connection-target.js";
import { JourneyError, type JourneyContext, type TargetProvider } from "./types.js";

export const provider: TargetProvider = {
  version: 1,
  async acquire(input) {
    if (input.config.baseline.connections.length) throw new JourneyError("unsupported", "local_connection_baseline_not_supported");
    const target = await startConnectionTarget(parseConnectionConfig({ target: { mode: "managed-local" } }), [], input.repositoryRoot, input.signal);
    const api = new ConnectionApi(input.browser.request, target.origin);
    const page = await input.browser.newPage().catch(async error => { await target.stop(); throw error; });
    const identity = async () => {
      const health = await api.get<{ commit: string; deploymentMode: string }>("/api/health");
      if (!/^[a-f0-9]{40}$/.test(health.commit) || health.deploymentMode !== "local_trusted") throw new JourneyError("blocked", "local_identity_unavailable");
      const settings = await api.get("/api/instance/settings/experimental");
      return { kind: "self-hosted" as const, targetId: input.config.id, origin: target.origin, commit: health.commit, cloudRelease: null, runtimeImage: null,
        effectiveFeatures: Object.fromEntries(Object.entries(settings).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>,
        configurationHash: createHash("sha256").update(JSON.stringify(settings)).digest("hex") };
    };
    return {
      async authenticate() { await api.get("/api/auth/get-session"); },
      async prepare(): Promise<JourneyContext> {
        if (Object.keys(input.config.baseline.features).length) await api.patch("/api/instance/settings/experimental", input.config.baseline.features);
        const effective = await api.get<Record<string, unknown>>("/api/instance/settings/experimental");
        if (Object.entries(input.config.baseline.features).some(([key, value]) => effective[key] !== value)) throw new JourneyError("failed", "configuration_did_not_converge");
        const company = await api.post<{ id: string; issuePrefix: string }>("/api/companies", { name: `Journey QA ${input.campaignId}` });
        const { user } = await api.get<{ user: { id: string; name: string } }>("/api/auth/get-session");
        return { page, api, company, user, identity: await identity(), capabilities: ["company", "board-user", "task-write"], startingState: "recipe" };
      },
      identity,
      async own() { /* Entire managed database belongs to this attempt. */ },
      async collect() {},
      async release() { await target.stop(); return "released" as const; },
    };
  },
};
