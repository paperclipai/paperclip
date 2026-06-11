import type { OAuthProviderConfig } from "./provider-config.js";

export interface ParsedTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  scope?: string[];
}

export interface ParsedAccountInfo {
  accountId: string;
  accountLabel?: string;
}

export interface ProviderShape {
  parseTokenResponse?: (raw: unknown) => ParsedTokenResponse;
  parseAccountInfo?: (raw: unknown) => ParsedAccountInfo;
}

export interface RegisteredProvider {
  config: OAuthProviderConfig;
  clientId: string;
  clientSecret: string;
  shape: ProviderShape; // resolved (default + override merged)
  source: "yaml" | "plugin";
}

export type { OAuthProviderConfig };
