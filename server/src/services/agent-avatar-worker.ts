import { parentPort } from "node:worker_threads";
import sharp from "sharp";
import { renderAgentSvg } from "@paperclipai/shared/cliplab/static";
import type { AgentAvatarRequest } from "./agent-avatars.js";

parentPort!.on("message", async (request: AgentAvatarRequest) => {
  try {
    const svg = renderAgentSvg(request.appearance, request.size, request.scale, request.pose, request.muted);
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    parentPort!.postMessage({ png });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : "Avatar rendering failed" });
  }
});
