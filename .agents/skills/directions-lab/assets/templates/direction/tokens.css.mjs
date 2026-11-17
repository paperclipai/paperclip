import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MOTION_ASSET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../motion/v1-mvp-motion.css");

export const motionBlock = (direction) => readFileSync(MOTION_ASSET, "utf8").replaceAll("<id>", direction.id).replaceAll("<p>", direction.prefix);

export default (ctx, direction) => {
  const p = direction.prefix;
  return `[data-direction="${direction.id}"] {
  --${p}-paper: #fafafa;
  --${p}-ink: #262626;
  --${p}-grid: repeat(auto-fill, minmax(200px, 1fr));
  --${p}-tile-h: 240px;
  --${p}-tile-radius: 12px;
  --${p}-tile-hover: var(--accent);
  --${p}-sheet-radius: 8px;
  --${p}-shadow-sheet: drop-shadow(0 3.406px 10px rgba(26, 26, 26, 0.0924));
  --${p}-shadow-print: 0 3.406px 20px rgba(26, 26, 26, 0.0924);
}

.dark [data-direction="${direction.id}"] {
  --${p}-tile-hover: #202020;
  --${p}-shadow-sheet: drop-shadow(0 3.406px 10px rgba(26, 26, 26, 0.18));
  --${p}-shadow-print: 0 3.406px 20px rgba(26, 26, 26, 0.18);
}

${motionBlock(direction)}`;
};
