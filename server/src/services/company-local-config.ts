import { promises as fs } from "node:fs";
import path from "node:path";
import {
  expandHomePrefix,
  readPaperclipCompanyConfig,
  resolvePaperclipCompanyConfigPath,
  type PaperclipCompanyConfig,
} from "@paperclipai/shared/home-paths";

export async function readCompanyLocalConfig(companyId: string): Promise<PaperclipCompanyConfig> {
  return readPaperclipCompanyConfig(companyId);
}

export async function writeCompanyLocalConfig(input: {
  companyId: string;
  workProductsRoot?: string | null;
}): Promise<void> {
  const configPath = resolvePaperclipCompanyConfigPath(input.companyId);
  const existing = readPaperclipCompanyConfig(input.companyId);
  const next: Record<string, string> = {};
  const workProductsRoot =
    input.workProductsRoot === undefined
      ? existing.workProductsRoot
      : input.workProductsRoot?.trim()
        ? path.resolve(expandHomePrefix(input.workProductsRoot))
        : null;

  if (workProductsRoot) next.workProductsRoot = workProductsRoot;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  if (Object.keys(next).length === 0) {
    await fs.rm(configPath, { force: true });
    return;
  }
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
