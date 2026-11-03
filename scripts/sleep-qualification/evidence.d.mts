export interface SleepQualificationIdentity {
  appSha: string;
  cloudSha: string;
  target: string;
  configDigest: string;
  collectorOrigins?: { telemetry: string; otel: string };
}
export interface SleepQualificationReport {
  version: number;
  target: string;
  appSha: string;
  cloudSha: string;
  configDigest: string;
  layers: Record<string, { verdict: 'VERIFIED' | 'NOT VERIFIED' | 'INCONCLUSIVE'; reason: string }>;
}
export function logicalSleepConfiguration(configuration: unknown): {
  automaticBackups: { intervalMinutes: number; idleCheckpoint: boolean };
  announcements: boolean;
  telemetry: boolean;
  otel: { enabled: boolean; protocol: 'http/json' };
  serveUi: boolean;
  managedInstance: boolean;
  deploymentMode: 'authenticated' | 'local_trusted';
  storageProvider: 's3' | 'local_disk';
};
export function sleepConfigurationDigest(configuration: unknown): string;
export function evaluateSleepQualification(receipt: unknown, expected: SleepQualificationIdentity): SleepQualificationReport;
export function finalizeLocalSleepReceipt<T extends Record<string, unknown>>(observations: T, expected: SleepQualificationIdentity, now?: () => string): {
  receipt: T & { finishedAt: string };
  report: SleepQualificationReport;
};
