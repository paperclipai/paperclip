import keytar from "keytar";
import { randomBytes } from "node:crypto";

const SERVICE = "paperclip-dpo";
const ACCOUNT = "mapping-store-key";

export async function getOrCreateMappingKey(): Promise<Buffer> {
  const existing = await keytar.getPassword(SERVICE, ACCOUNT);
  if (existing) {
    return Buffer.from(existing, "base64");
  }
  const key = randomBytes(32);
  await keytar.setPassword(SERVICE, ACCOUNT, key.toString("base64"));
  return key;
}

export async function deleteMappingKey(): Promise<void> {
  await keytar.deletePassword(SERVICE, ACCOUNT);
}
