import type { Dpo } from "./index.js";

export interface SafeExternalLlmOptions {
  dpo: Dpo;
  prompt: string;
  targetLlm: string;
  agent: string;
  tenantId?: string;
  externalCall: (anonymizedPrompt: string) => Promise<string>;
}

export type SafeExternalLlmResult =
  | { blocked: false; text: string }
  | { blocked: true; reason: string };

export async function safeExternalLlm(opts: SafeExternalLlmOptions): Promise<SafeExternalLlmResult> {
  const a = await opts.dpo.anonymize({
    text: opts.prompt,
    targetLlm: opts.targetLlm,
    agent: opts.agent,
    tenantId: opts.tenantId,
  });
  if ("blocked" in a) {
    return { blocked: true, reason: a.reason };
  }
  const externalText = await opts.externalCall(a.anonymizedText);
  const back = opts.dpo.deanonymize({ mappingId: a.mappingId, text: externalText });
  return { blocked: false, text: back.text };
}
