import { createHash } from "node:crypto";
import {
  photonLineIdSchema,
  photonProjectIdSchema,
  type PhotonProjectInspection,
} from "@paperclipai/shared";
import { IMessageError } from "@photon-ai/advanced-imessage";

const CLOUD_ORIGIN = "https://spectrum.photon.codes";
const MAX_RESPONSE_BYTES = 256 * 1024;
export class PhotonError extends Error {
  constructor(
    readonly code:
      | "credentials"
      | "line_unavailable"
      | "quota"
      | "network"
      | "history_gap"
      | "delivery_unknown"
      | "attachment_not_ready"
      | "invalid_response"
      | "rejected",
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PhotonError";
  }
}

/** Only documented semantic rejections prove a write did not happen. */
export function photonFailure(error: unknown, writing = false): PhotonError {
  if (error instanceof PhotonError) return error;
  if (error instanceof IMessageError) {
    if (
      [
        "unauthenticated",
        "tokenExpired",
        "tokenBlocked",
        "unauthorized",
      ].includes(error.code)
    )
      return new PhotonError(
        "credentials",
        "Photon rejected the selected line credentials; reconnect the channel",
      );
    if (
      [
        "dailyLimitExceeded",
        "recipientLimitExceeded",
        "uploadRateExceeded",
        "recipientCoolingDown",
        "recipientLocked",
        "sendReceiveRatioExceeded",
        "contentDuplicateExceeded",
      ].includes(error.code)
    )
      return new PhotonError(
        "quota",
        "Photon has temporarily limited this line",
        error.retryAfter,
      );
    if (error.code === "attachmentNotReady")
      return new PhotonError(
        "attachment_not_ready",
        "Photon attachment is still being prepared",
      );
    if (
      [
        "chatNotFound",
        "messageNotFound",
        "attachmentNotFound",
        "invalidArgument",
        "preconditionFailed",
        "operationNotSupported",
      ].includes(error.code)
    )
      return new PhotonError(
        "rejected",
        `Photon rejected the operation (${error.code})`,
      );
  }
  return writing
    ? new PhotonError(
        "delivery_unknown",
        "Photon delivery is unknown; reconcile its receipt before retrying",
      )
    : new PhotonError("network", "Photon connection interrupted; retrying");
}
/** Shared credentials own one project, not any number in the provider pool. */
export function photonSharedIdentity(projectId: string): string {
  photonProjectIdSchema.parse(projectId);
  return `photon-project:${projectId}`;
}
export function photonSharedScope(projectId: string): string {
  photonProjectIdSchema.parse(projectId);
  return `shared-${createHash("sha256").update(projectId).digest("hex").slice(0, 48)}`;
}
interface CloudAllocation {
  sharedToken?: string;
  inspection: PhotonProjectInspection;
  tokens: ReadonlyMap<string, string>;
  expiresIn: number;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Only this module ever sees a Cloud project secret or minted line tokens. */
export class PhotonCloudClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  private async request(
    projectId: string,
    projectSecret: string,
    suffix: string,
    method: string,
  ): Promise<unknown> {
    photonProjectIdSchema.parse(projectId);
    if (!projectSecret || projectSecret.length > 4096)
      throw new PhotonError("credentials", "Enter a Photon project secret");
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${CLOUD_ORIGIN}/projects/${encodeURIComponent(projectId)}/${suffix}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            authorization: `Basic ${Buffer.from(`${projectId}:${projectSecret}`).toString("base64")}`,
            accept: "application/json",
          },
        },
      );
    } catch {
      throw new PhotonError(
        "network",
        "Photon Cloud could not be reached; retry the connection",
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new PhotonError(
        "credentials",
        "Photon rejected this project ID or secret",
      );
    if (response.status === 429)
      throw new PhotonError(
        "quota",
        "Photon Cloud request limit reached; retry later",
      );
    if (!response.ok)
      throw new PhotonError(
        "network",
        `Photon Cloud returned HTTP ${response.status}`,
      );
    const reader = response.body?.getReader();
    if (!reader)
      throw new PhotonError(
        "invalid_response",
        "Photon returned an empty response",
      );
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > MAX_RESPONSE_BYTES)
          throw new PhotonError(
            "invalid_response",
            "Photon project response exceeds the supported size",
          );
        chunks.push(next.value);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!record(body) || body.succeed !== true || !record(body.data))
        throw new PhotonError(
          "invalid_response",
          "Photon did not return a valid project response",
        );
      return body.data;
    } catch (error) {
      if (error instanceof PhotonError) throw error;
      throw new PhotonError(
        "invalid_response",
        "Photon returned an invalid project response",
      );
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  async allocation(
    projectId: string,
    projectSecret: string,
  ): Promise<CloudAllocation> {
    const project = await this.request(projectId, projectSecret, "", "GET");
    if (
      record(project) &&
      typeof project.id === "string" &&
      project.id !== projectId
    )
      throw new PhotonError(
        "credentials",
        "Photon returned a different project identity",
      );
    const data = await this.request(
      projectId,
      projectSecret,
      "imessage/tokens",
      "POST",
    );
    if (!record(data))
      throw new PhotonError("invalid_response", "Photon allocation is missing");
    const projectName =
      record(project) && typeof project.name === "string"
        ? project.name.slice(0, 160)
        : projectId;
    const inspection: PhotonProjectInspection = {
      projectId,
      projectName,
      allocation: data.type === "dedicated" ? "dedicated" : "shared",
      eligible: false,
      lines: [],
    };
    if (data.type === "shared") {
      if (typeof data.token !== "string" || !data.token || data.token.length > 16_384 ||
          typeof data.expiresIn !== "number" || !Number.isFinite(data.expiresIn) || data.expiresIn < 30)
        throw new PhotonError("invalid_response", "Photon returned invalid shared project credentials");
      inspection.eligible = true;
      return { inspection, sharedToken: data.token, tokens: new Map(), expiresIn: Math.min(data.expiresIn, 86_400) };
    }
    if (
      data.type !== "dedicated" ||
      !record(data.auth) ||
      !record(data.numbers) ||
      typeof data.expiresIn !== "number" ||
      !Number.isFinite(data.expiresIn) ||
      data.expiresIn < 30
    ) {
      throw new PhotonError(
        "line_unavailable",
        "Photon did not supply a dedicated line with a stable phone number",
      );
    }
    const tokens = new Map<string, string>();
    for (const [lineId, token] of Object.entries(data.auth)) {
      if (
        !photonLineIdSchema.safeParse(lineId).success ||
        typeof token !== "string" ||
        !token ||
        token.length > 16_384
      )
        continue;
      const phoneNumber = data.numbers[lineId];
      if (
        typeof phoneNumber !== "string" ||
        !/^\+[1-9]\d{6,14}$/.test(phoneNumber)
      )
        continue;
      tokens.set(lineId, token);
      inspection.lines.push({ lineId, phoneNumber, eligible: true });
    }
    if (inspection.lines.length > 256)
      throw new PhotonError(
        "invalid_response",
        "Photon returned too many lines",
      );
    inspection.eligible = inspection.lines.length > 0;
    return { inspection, tokens, expiresIn: Math.min(data.expiresIn, 86_400) };
  }
  async inspect(
    projectId: string,
    projectSecret: string,
  ): Promise<PhotonProjectInspection> {
    return (await this.allocation(projectId, projectSecret)).inspection;
  }
}

/** A fixed identity; renewal can replace its token, never its project/line/number. */
export class PhotonLineAuthentication {
  private current: { token: string; renewAt: number } | undefined;
  private renewing: Promise<string> | undefined;
  private retired = false;
  constructor(
    readonly identity: {
      allocation?: "shared" | "dedicated";
      projectId: string;
      lineId: string;
      phoneNumber: string;
    },
    private readonly secret: string,
    private readonly cloud = new PhotonCloudClient(),
    private readonly now = Date.now,
  ) {
    photonProjectIdSchema.parse(identity.projectId);
    photonLineIdSchema.parse(identity.lineId);
    if (identity.allocation === "shared" && (identity.lineId !== photonSharedScope(identity.projectId) || identity.phoneNumber !== photonSharedIdentity(identity.projectId)))
      throw new PhotonError("credentials", "Photon shared identity must match its project");
  }
  get address(): string {
    return this.identity.allocation === "shared" ? "imessage.spectrum.photon.codes:443" : `${this.identity.lineId}.imsg.photon.codes:443`;
  }
  retire(): void {
    this.retired = true;
    this.current = undefined;
  }
  async token(): Promise<string> {
    if (this.retired)
      throw new PhotonError("credentials", "Photon runtime has been retired");
    if (this.current && this.current.renewAt > this.now())
      return this.current.token;
    this.renewing ??= this.renew().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }
  private async renew(): Promise<string> {
    this.current = undefined;
    const allocation = await this.cloud.allocation(
      this.identity.projectId,
      this.secret,
    );
    if (allocation.inspection.allocation !== (this.identity.allocation ?? "dedicated"))
      throw new PhotonError("line_unavailable", "Photon project allocation changed; create a new channel for the new identity");
    if (this.identity.allocation === "shared") {
      if (!allocation.sharedToken || this.retired)
        throw new PhotonError("credentials", "Photon shared credentials are unavailable");
      this.current = { token: allocation.sharedToken, renewAt: this.now() + allocation.expiresIn * 800 };
      return allocation.sharedToken;
    }
    const line = allocation.inspection.lines.find(
      (candidate) => candidate.lineId === this.identity.lineId,
    );
    const token = allocation.tokens.get(this.identity.lineId);
    if (
      !line?.eligible ||
      line.phoneNumber !== this.identity.phoneNumber ||
      !token
    )
      throw new PhotonError(
        "line_unavailable",
        "The selected Photon number is no longer available; reconnect the same line or create a new channel",
      );
    if (this.retired)
      throw new PhotonError("credentials", "Photon runtime has been retired");
    this.current = { token, renewAt: this.now() + allocation.expiresIn * 800 };
    return token;
  }
}
