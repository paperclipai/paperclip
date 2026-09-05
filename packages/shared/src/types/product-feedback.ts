export const PRODUCT_FEEDBACK_MAX_LENGTH = 5_000;
export const PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT = 5;
export const PRODUCT_FEEDBACK_SCHEMA_VERSION = "paperclip-product-feedback-v2";

export interface ProductFeedbackCapability {
  enabled: boolean;
  limits: {
    feedbackMaxLength: number;
    diagnosticCount: number;
  };
}

export const DISABLED_PRODUCT_FEEDBACK_CAPABILITY: ProductFeedbackCapability = {
  enabled: false,
  limits: {
    feedbackMaxLength: PRODUCT_FEEDBACK_MAX_LENGTH,
    diagnosticCount: PRODUCT_FEEDBACK_DIAGNOSTIC_LIMIT,
  },
};

export interface ProductFeedbackDiagnostic {
  code: string;
  component: string;
  routeTemplate: string;
  timestamp: string;
}

export interface ProductFeedbackContext {
  routeTemplate: string;
  appVersion: string | null;
  deploymentMode: "local_trusted" | "authenticated";
  browser: string;
  operatingSystem: string;
  diagnostics: ProductFeedbackDiagnostic[];
}

export interface ProductFeedbackSubmissionRequest {
  companyId: string;
  schemaVersion: typeof PRODUCT_FEEDBACK_SCHEMA_VERSION;
  submissionId: string;
  submittedAt: string;
  feedback: string;
  followUpConsent: boolean;
  reporterEmail?: string;
  context: ProductFeedbackContext;
}

export type ProductFeedbackRelayRequest = Omit<ProductFeedbackSubmissionRequest, "companyId">;

export interface ProductFeedbackReceipt {
  ok: true;
  duplicate: boolean;
  submissionId: string;
  receiptId: string;
}
