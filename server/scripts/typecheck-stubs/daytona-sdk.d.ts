// Server tests reach Daytona plugin source, but the root install does not install
// that plugin's dependencies. Its own project checks that source against the real
// package. The server tests only need these names to resolve. Async calls return a
// Promise because a bare `any` makes the plugin's generic helpers infer `unknown`.
type AsyncMembers = { [member: string]: (...args: any[]) => Promise<any> };

export declare class Daytona {
  constructor(config?: DaytonaConfig);
  snapshot: AsyncMembers;
  get(...args: any[]): Promise<any>;
  create(...args: any[]): Promise<any>;
  list(...args: any[]): Promise<any>;
  [member: string]: any;
}
export declare class DaytonaNotFoundError extends Error {}
export declare class DaytonaTimeoutError extends Error {}
export type CreateSandboxBaseParams = any;
export type CreateSandboxFromImageParams = any;
export type CreateSandboxFromSnapshotParams = any;
export type DaytonaConfig = any;
export type FileDownloadRequest = any;
export type FileDownloadResponse = any;
export type FileUpload = any;
export type Resources = any;
export interface Sandbox {
  fs: { downloadFiles(...args: any[]): Promise<any[]>; [member: string]: (...args: any[]) => Promise<any> };
  process: {
    createPty: (...args: any[]) => Promise<any>;
    executeCommand(...args: any[]): Promise<{ result?: string; artifacts?: { stdout?: string }; exitCode?: number }>;
    getSessionCommandLogs(
      sessionId: string,
      commandId: string,
      onStdout?: (chunk: string) => void,
      onStderr?: (chunk: string) => void,
    ): Promise<any>;
    [member: string]: (...args: any[]) => Promise<any>;
  };
  [member: string]: any;
}
