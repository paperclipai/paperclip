import type * as React from "react";

export interface DesktopConfig {
  baseUrl: string;
  workspacePrefix: string;
  lastLaunchUrl: string;
}

export interface DesktopMeta {
  productName: string;
  version: string;
  platform: string;
}

export interface HealthInfo {
  status: string;
  version?: string;
  deploymentMode?: string;
  deploymentExposure?: string;
  authReady?: boolean;
  bootstrapStatus?: string;
}

export interface CompanyInfo {
  id: string;
  name: string;
  status: string;
  issuePrefix: string;
}

export interface ConnectionProbe {
  ok: boolean;
  baseUrl: string;
  checkedAt: string;
  companies: CompanyInfo[];
  health?: HealthInfo;
  error?: string;
}

export interface DesktopBridge {
  meta(): Promise<DesktopMeta>;
  loadConfig(): Promise<DesktopConfig>;
  saveConfig(partialConfig: Partial<DesktopConfig>): Promise<DesktopConfig>;
  probeConnection(baseUrl: string): Promise<ConnectionProbe>;
  detectConnection(): Promise<ConnectionProbe>;
  openExternal(targetUrl: string): Promise<void>;
}

declare global {
  interface Window {
    neurOSDesktop: DesktopBridge;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        allowpopups?: boolean;
        partition?: string;
        src?: string;
        useragent?: string;
      };
    }
  }
}

export {};
