import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entries = [
  ["src/onboarding-assets", "dist/onboarding-assets"],
  ["src/built-ins", "dist/built-ins"],
  ["src/services/scripts", "dist/services/scripts"],
  ["../packages/paperclip-runner/dist", "dist/vendor/paperclip-runner"],
];

await Promise.all(
  entries.map(async ([source, target]) => {
    const sourcePath = join(serverRoot, source);
    const targetPath = join(serverRoot, target);
    await mkdir(targetPath, { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true, force: true });
  }),
);
