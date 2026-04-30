import { Resend } from "resend";
import type { ResendMcpConfig } from "./config.js";

export class ResendApiError extends Error {
  constructor(
    public readonly statusCode: number | undefined,
    public readonly resendName: string,
    message: string,
  ) {
    super(`Resend API [${statusCode ?? "unknown"}] ${resendName}: ${message}`);
    this.name = "ResendApiError";
  }
}

export interface SendEmailPayload {
  from: string;
  to: string[];
  subject: string;
  html: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  tags?: Array<{ name: string; value: string }>;
}

export class ResendClient {
  private readonly resend: Resend;

  constructor(config: ResendMcpConfig) {
    this.resend = new Resend(config.apiKey);
  }

  async sendEmail(payload: SendEmailPayload): Promise<{ id: string }> {
    const { data, error } = await this.resend.emails.send(payload);
    if (error) throw new ResendApiError(error.statusCode ?? undefined, error.name, error.message);
    return data!;
  }

  async sendBatch(emails: SendEmailPayload[]): Promise<{ data: Array<{ id: string }> }> {
    const { data, error } = await this.resend.batch.send(emails);
    if (error) throw new ResendApiError(error.statusCode ?? undefined, error.name, error.message);
    return { data: data!.data };
  }
}
