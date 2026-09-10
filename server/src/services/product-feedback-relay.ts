import {
  productFeedbackReceiptSchema,
  type ProductFeedbackReceipt,
  type ProductFeedbackRelayRequest,
} from "@paperclipai/shared";

const DEFAULT_PRODUCT_FEEDBACK_ENDPOINT = "https://telemetry.paperclip.ing/product-feedback";
const MAX_RESPONSE_BYTES = 16 * 1024;

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("product_feedback_response_too_large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("product_feedback_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString("utf8");
}

export class ProductFeedbackRelayError extends Error {
  constructor(readonly status: number) {
    super(`product_feedback_relay_http_${status}`);
    this.name = "ProductFeedbackRelayError";
  }
}

export interface ProductFeedbackRelay {
  submit(request: ProductFeedbackRelayRequest): Promise<ProductFeedbackReceipt>;
}

export function createHttpProductFeedbackRelay(
  fetchImpl: typeof fetch = fetch,
  endpoint = DEFAULT_PRODUCT_FEEDBACK_ENDPOINT,
): ProductFeedbackRelay {
  return {
    async submit(request) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProductFeedbackRelayError(response.status);
      }
      return productFeedbackReceiptSchema.parse(JSON.parse(await readBoundedResponseText(response)));
    },
  };
}
