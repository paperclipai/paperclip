/**
 * Configure Slack Chat OS for the Blockcast company.
 *
 * Creates (or rotates) two Paperclip secrets and rewrites the plugin's
 * instance config to reference them by UUID, so the worker can activate.
 *
 * Inputs (env vars — no CLI args, to keep secrets out of shell history):
 *   SLACK_BOT_TOKEN          required, e.g. xoxb-…
 *   SLACK_SIGNING_SECRET     required, 32 lowercase hex chars
 *   SLACK_DEFAULT_CHANNEL_ID optional, e.g. C01ABC2DEF3 — replaces the
 *                            broken "paperclip" channel name if provided
 *   PAPERCLIP_DB_URL                    optional, defaults to local embedded
 *   PAPERCLIP_SECRETS_MASTER_KEY_FILE   optional, defaults to the daemon's
 *                                       ~/.paperclip/instances/default/secrets/master.key
 *
 * Suggested invocation that does not echo secrets:
 *   read -rs -p "Bot token: "       SLACK_BOT_TOKEN; echo
 *   read -rs -p "Signing secret: "  SLACK_SIGNING_SECRET; echo
 *   export SLACK_BOT_TOKEN SLACK_SIGNING_SECRET
 *   node scripts/blockcast-slack-secrets.ts
 *
 * After it succeeds: open the Slack Chat OS plugin settings in the UI and
 * click Save (or POST /api/plugins/<id>/enable) to trigger worker
 * reactivation. The plugin should transition out of `error` state.
 *
 * The script uses the same encryption scheme the daemon uses
 * (local_encrypted_v1 = AES-256-GCM, key from master.key) so the worker
 * decrypts the resulting versions correctly via the standard host
 * services secrets handler.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import postgres from "../node_modules/.pnpm/postgres@3.4.8/node_modules/postgres/src/index.js";

const COMPANY_ID = "aaced805-3491-4ee5-9b14-cdf70cb81d47"; // Blockcast
const PLUGIN_KEY = "paperclip-plugin-slack";
const BOT_SECRET_NAME = "slack-bot-token";
const SIGNING_SECRET_NAME = "slack-signing-secret";
const ACTOR = "blockcast-setup-script";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

function loadMasterKey(): Buffer {
  const inline = process.env.PAPERCLIP_SECRETS_MASTER_KEY?.trim();
  const file =
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE?.trim() ||
    path.join(homedir(), ".paperclip", "instances", "default", "secrets", "master.key");

  const raw = (inline ?? readFileSync(file, "utf8")).trim();
  // Mirror server/src/secrets/local-encrypted-provider.ts decoding rules.
  if (/^[A-Fa-f0-9]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  if (Buffer.byteLength(raw, "utf8") === 32) return Buffer.from(raw, "utf8");
  throw new Error(`Cannot decode master key (need 32-byte base64, 64-char hex, or raw 32-char string)`);
}

function encryptValue(masterKey: Buffer, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    material: {
      scheme: "local_encrypted_v1" as const,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
    valueSha256: createHash("sha256").update(value).digest("hex"),
  };
}

async function upsertSecret(
  sql: ReturnType<typeof postgres>,
  masterKey: Buffer,
  name: string,
  value: string,
): Promise<{ id: string; action: "created" | "rotated" }> {
  const enc = encryptValue(masterKey, value);

  const existing = await sql<{ id: string; latest_version: number }[]>`
    SELECT id, latest_version FROM company_secrets
    WHERE company_id = ${COMPANY_ID} AND name = ${name}
    LIMIT 1
  `;

  if (existing.length > 0) {
    const { id, latest_version } = existing[0];
    const next = latest_version + 1;
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO company_secret_versions
          (secret_id, version, material, value_sha256, created_by_user_id)
        VALUES (${id}, ${next}, ${tx.json(enc.material)}, ${enc.valueSha256}, ${ACTOR})
      `;
      await tx`
        UPDATE company_secrets
        SET latest_version = ${next}, updated_at = NOW()
        WHERE id = ${id}
      `;
    });
    return { id, action: "rotated" };
  }

  const inserted = await sql.begin(async (tx) => {
    const [secret] = await tx<{ id: string }[]>`
      INSERT INTO company_secrets
        (company_id, name, provider, latest_version, created_by_user_id)
      VALUES (${COMPANY_ID}, ${name}, 'local_encrypted', 1, ${ACTOR})
      RETURNING id
    `;
    await tx`
      INSERT INTO company_secret_versions
        (secret_id, version, material, value_sha256, created_by_user_id)
      VALUES (${secret.id}, 1, ${tx.json(enc.material)}, ${enc.valueSha256}, ${ACTOR})
    `;
    return secret.id;
  });
  return { id: inserted, action: "created" };
}

async function main() {
  const botToken = requireEnv("SLACK_BOT_TOKEN");
  const signingSecret = requireEnv("SLACK_SIGNING_SECRET");
  const channelId = process.env.SLACK_DEFAULT_CHANNEL_ID?.trim();

  const masterKey = loadMasterKey();
  const dbUrl =
    process.env.PAPERCLIP_DB_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
  const sql = postgres(dbUrl);

  try {
    const [plugin] = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM plugins WHERE plugin_key = ${PLUGIN_KEY} LIMIT 1
    `;
    if (!plugin) {
      console.error(`Plugin not found: ${PLUGIN_KEY}`);
      process.exit(1);
    }
    console.log(`Plugin row: ${plugin.id} (status=${plugin.status})`);

    const bot = await upsertSecret(sql, masterKey, BOT_SECRET_NAME, botToken);
    console.log(`Bot token secret ${bot.action}: ${bot.id}`);
    const signing = await upsertSecret(sql, masterKey, SIGNING_SECRET_NAME, signingSecret);
    console.log(`Signing secret ${signing.action}: ${signing.id}`);

    const [cfg] = await sql<{ config_json: Record<string, unknown> | null }[]>`
      SELECT config_json FROM plugin_config WHERE plugin_id = ${plugin.id} LIMIT 1
    `;
    const current = cfg?.config_json ?? {};
    const next: Record<string, unknown> = {
      ...current,
      slackTokenRef: bot.id,
      slackSigningSecretRef: signing.id,
    };
    if (channelId) next.defaultChannelId = channelId;

    await sql`
      UPDATE plugin_config
      SET config_json = ${sql.json(next)}, last_error = NULL, updated_at = NOW()
      WHERE plugin_id = ${plugin.id}
    `;
    console.log("plugin_config updated.");

    console.log(
      `\nNext: open the Slack Chat OS settings in the UI and click Save,\n` +
        `or POST /api/plugins/${plugin.id}/enable, to trigger worker reactivation.`,
    );
    if (!channelId) {
      console.log(
        `\nReminder: defaultChannelId is still "${current.defaultChannelId ?? ""}". ` +
          `Slack APIs need a channel ID like C01ABC2DEF3, not a name. ` +
          `Re-run with SLACK_DEFAULT_CHANNEL_ID=… or fix it in the settings UI.`,
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
