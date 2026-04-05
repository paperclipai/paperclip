
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, resolveHermesHome } from '../shared/utils.js';

/**
 * Local adapters do not have a webhook target to notify a remote runtime.
 *
 * Instead, this hook writes a durable notification file that:
 * - operators can inspect,
 * - troubleshooting agents can reason about,
 * - and future adapter prompt logic can surface if desired.
 *
 * This makes the hook non-destructive and observable.
 *
 * @param {{
 *   companyId: string,
 *   agentId: string,
 *   agentName: string,
 *   adapterType: string,
 *   source: string,
 *   sourceId: string,
 *   approvedAt: string,
 *   message: string
 * }} payload
 * @param {Record<string, unknown>} adapterConfig
 */
export async function onHireApproved(payload, adapterConfig = {}) {
  try {
    const root = path.join(resolveHermesHome(adapterConfig), 'paperclip-notifications', 'hire-approved');
    await ensureDir(root);
    const fileName = `${payload.approvedAt.replace(/[:.]/g, '-')}-${payload.agentId}.json`;
    const filePath = path.join(root, fileName);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, detail: { filePath } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      detail: {},
    };
  }
}
