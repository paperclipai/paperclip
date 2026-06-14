// scripts/seed-cheap-model-profile.mjs
// Sets adapter_config.modelProfiles.cheap.adapterConfig.model = gemma for every
// lmstudio_local agent whose DEFAULT model is a Qwen reasoning model, across all
// companies. Idempotent: re-running makes no change once seeded.
import pg from "pg";

const CHEAP_MODEL = "gemma-4-31b-it-mlx";
const client = new pg.Client({ connectionString: "postgres://paperclip:paperclip@localhost:54329/paperclip" });

function isQwenDefault(model) {
  return typeof model === "string" && model.toLowerCase().startsWith("qwen3");
}

await client.connect();
const { rows } = await client.query(
  `SELECT id, name, company_id, adapter_config FROM agents WHERE adapter_type = 'lmstudio_local'`,
);

let changed = 0;
for (const row of rows) {
  const cfg = row.adapter_config ?? {};
  if (!isQwenDefault(cfg.model)) continue;
  const existing = cfg.modelProfiles?.cheap?.adapterConfig?.model;
  if (existing === CHEAP_MODEL) continue;
  const next = {
    ...cfg,
    modelProfiles: {
      ...(cfg.modelProfiles ?? {}),
      cheap: { enabled: true, adapterConfig: { model: CHEAP_MODEL } },
    },
  };
  await client.query(`UPDATE agents SET adapter_config = $1 WHERE id = $2`, [next, row.id]);
  console.log(`seeded cheap profile: ${row.name} (${row.company_id})`);
  changed += 1;
}
console.log(`done. ${changed} agent(s) updated, ${rows.length} lmstudio_local agent(s) scanned.`);
await client.end();
