export interface DurumKaynak {
  issueId: string | null;
  issueTitle: string | null;
  documentKey: string;
}

export type SosyalMedyaSnapshot =
  | { status: "ok"; data: import("./parse-durum.js").SosyalMedyaVeri; uyarilar: string[]; source: DurumKaynak; scannedIssueCount: number }
  | { status: "empty"; source: DurumKaynak; scannedIssueCount: number }
  | { status: "not-found"; source: DurumKaynak; scannedIssueCount: number; reason: string }
  | { status: "invalid"; source: DurumKaynak | null; scannedIssueCount: number; reason: string }
  | { status: "no-company"; source: null; scannedIssueCount: 0 };

export interface PanelConfig {
  issueId: string | null;
  documentKey: string;
  scanLimit: number;
}
