import { encode } from "uqr";
import type { LoginQrPayload } from "./types.js";

export function qrImageDataUrl(text: string): LoginQrPayload {
  const { data, size } = encode(text);
  const cell = 4;
  const pad = 4;
  const dim = (size + pad * 2) * cell;
  let rects = "";
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (data[y]?.[x]) {
        rects += `<rect x="${(x + pad) * cell}" y="${(y + pad) * cell}" width="${cell}" height="${cell}"/>`;
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">${rects}</svg>`;
  return { imageDataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` };
}

export function telegramQrUrl(token: Uint8Array | Buffer | string): string {
  const bytes = typeof token === "string" ? Buffer.from(token, "base64url") : Buffer.from(token);
  return `tg://login?token=${bytes.toString("base64url")}`;
}
