export type GithubConnectionTestStatus = "success" | "error" | null;

export interface CompanyGithubConnection {
  id: string;
  companyId: string;
  name: string;
  hostname: string;
  secretId: string;
  secretName: string;
  enabled: boolean;
  accountLogin: string | null;
  lastTestedAt: Date | null;
  lastTestStatus: GithubConnectionTestStatus;
  lastTestMessage: string | null;
  projectCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GithubConnectionTestResult {
  ok: boolean;
  accountLogin: string | null;
  hostname: string;
  message: string;
  testedAt: Date;
}
