/**
 * Forwards serialized HTTP requests from the relay tunnel to the local
 * Paperclip server and returns serialized responses.
 */

import * as http from "node:http";
import type { HttpRequest, HttpResponse } from "./protocol.js";

// Headers where comma-joining is unsafe (values contain literal commas).
// These are sent as JSON arrays via a companion header instead.
const MULTI_VALUE_HEADERS = new Set(["set-cookie"]);

export function forwardHttpRequest(
  req: HttpRequest,
  localPort: number,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(req.body, "base64");

    const opts: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: localPort,
      path: req.path,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${localPort}`,
      },
    };

    const proxyReq = http.request(opts, (proxyRes) => {
      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on("error", (err) => reject(err));
      proxyRes.on("end", () => {
        const responseBody = Buffer.concat(chunks);

        // Collect headers. Multi-value headers like set-cookie cannot be
        // comma-joined (cookie values contain commas in date strings).
        // These are sent as JSON arrays in a companion header.
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value) && MULTI_VALUE_HEADERS.has(key)) {
            headers[key] = JSON.stringify(value);
            headers[`x-relay-multi-${key}`] = "1";
          } else {
            headers[key] = Array.isArray(value) ? value.join(", ") : value;
          }
        }

        resolve({
          id: req.id,
          type: "http-response",
          status: proxyRes.statusCode ?? 502,
          headers,
          body: responseBody.toString("base64"),
        });
      });
    });

    proxyReq.on("error", (err) => {
      reject(err);
    });

    if (body.length > 0) {
      proxyReq.write(body);
    }
    proxyReq.end();
  });
}
