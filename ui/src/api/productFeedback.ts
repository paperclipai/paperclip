import {
  API,
  productFeedbackReceiptSchema,
  type ProductFeedbackReceipt,
  type ProductFeedbackSubmissionRequest,
} from "@paperclipai/shared";

export class ProductFeedbackApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProductFeedbackApiError";
  }
}

export const productFeedbackApi = {
  submit: async (input: ProductFeedbackSubmissionRequest): Promise<ProductFeedbackReceipt> => {
    const response = await fetch(API.productFeedback, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json().catch(() => null) as {
      code?: string;
      error?: string;
    } | null;
    if (!response.ok) {
      throw new ProductFeedbackApiError(
        payload?.error ?? "Feedback could not be sent. Your draft is still here.",
        payload?.code ?? "product_feedback_delivery_failed",
        response.status,
      );
    }
    return productFeedbackReceiptSchema.parse(payload);
  },
};
