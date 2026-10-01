import { eq } from "drizzle-orm";
import { agents, createDb } from "@paperclipai/db";
import { secretService } from "../server/src/services/secrets.js";

const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

type EnvBinding =
  | string
  | { type: "plain"; value: string }
  | { type: "secret_ref"; secretId: string; version?: number | "latest" };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toPlainValue(binding: unknown): string | null {
  if (typeof binding === "string") return binding;
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) return null;
  const rec = binding as Record<string, unknown>;
  if (rec.type === "plain" && typeof rec.value === "string") return rec.value;
  return null;
}

function secretName(agentId: string, key: string) {
  return `agent_${agentId.slice(0, 8)}_${key.toLowerCase()}`;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const db = createDb(dbUrl);
  const secrets = secretService(db);

  const allAgents = await db.select().from(agents);
  let changedAgents = 0;
  let createdSecrets = 0;
  let rotatedSecrets = 0;

  for (const agent of allAgents) {
    const adapterConfig = asRecord(agent.adapterConfig);
    if (!adapterConfig) continue;
    const env = asRecord(adapterConfig.env);
    if (!env) continue;

    let changed = false;
    const nextEnv: Record<string, EnvBinding> = { ...(env as Record<string, EnvBinding>) };

    for (const [key, rawBinding] of Object.entries(env)) {
      if (!SENSITIVE_ENV_KEY_RE.test(key)) continue;
      const plain = toPlainValue(rawBinding);
      if (plain === null) continue;
      if (plain.trim().length === 0) continue;

      const name = secretName(agent.id, key);
      if (apply) {
        const existing = await secrets.getByName(agent.companyId, name);
        if (existing) {
          await secrets.rotate(
            existing.id,
            { value: plain },
            { userId: "migration", agentId: null },
          );
          rotatedSecrets += 1;
          nextEnv[key] = { type: "secret_ref", secretId: existing.id, version: "latest" };
        } else {
          const created = await secrets.create(
            agent.companyId,
            {
              name,
              provider: "local_encrypted",
              value: plain,
              description: `Migrated from agent ${agent.id} env ${key}`,
            },
            { userId: "migration", agentId: null },
          );
          createdSecrets += 1;
          nextEnv[key] = { type: "secret_ref", secretId: created.id, version: "latest" };
        }
      } else {
        nextEnv[key] = {
          type: "secret_ref",
          secretId: `<would-create:${name}>`,
          version: "latest",
        };
      }
      changed = true;
    }

    if (!changed) continue;
    changedAgents += 1;

    if (apply) {
      await db
        .update(agents)
        .set({
          adapterConfig: {
            ...adapterConfig,
            env: nextEnv,
          },
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agent.id));
    }
  }

  if (!apply) {
    console.log(`Dry run: ${changedAgents} agents would be updated`);
    console.log("Re-run with --apply to persist changes");
    process.exit(0);
  }

  console.log(
    `Updated ${changedAgents} agents, created ${createdSecrets} secrets, rotated ${rotatedSecrets} secrets`,
  );
  process.exit(0);
}

void main();
