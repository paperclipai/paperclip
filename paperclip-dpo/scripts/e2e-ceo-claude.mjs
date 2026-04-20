import { createDpo, safeExternalLlm } from "../dist/index.js";
import { getOrCreateMappingKey } from "../dist/keychain.js";
import { mkdirSync } from "node:fs";

const STATE = "/tmp/dpo-e2e";
mkdirSync(STATE, { recursive: true });

const dpo = createDpo({
  mappingDbPath: `${STATE}/mappings.db`,
  mappingKey: await getOrCreateMappingKey(),
  auditDir: `${STATE}/audit`,
  classifier: {
    url: "http://localhost:1234",
    model: process.env.LM_STUDIO_MODEL ?? "gemma-4-26b",
    timeoutMs: 30000,
  },
});

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

const prompt = process.argv.slice(2).join(" ") ||
  "Max Mustermann von WHITESTAG GmbH (Cottbus, max@whitestag.de) braucht eine kurze Begrüßung.";

const out = await safeExternalLlm({
  dpo,
  prompt,
  targetLlm: "claude-opus-4-7",
  agent: "manual-e2e",
  externalCall: callClaude,
});

console.log("=== Original Prompt ===");
console.log(prompt);
console.log("\n=== Result ===");
console.log(out);
dpo.close();
