type PaperclipActor = {
  type: "none" | "board" | "agent";
  userId?: string | null;
  companyIds?: string[];
  memberships?: Array<{
    companyId: string;
    membershipRole?: string | null;
    status?: string;
  }>;
  isInstanceAdmin?: boolean;
  agentId?: string | null;
  companyId?: string | null;
  runId?: string | null;
  source?:
    | "local_implicit"
    | "session"
    | "board_key"
    | "agent_key"
    | "agent_jwt"
    | "cloud_tenant"
    | "none";
};

declare module "express-serve-static-core" {
  interface Request {
    actor: PaperclipActor;
  }
}

declare global {
  namespace Express {
    interface Request {
      actor: PaperclipActor;
    }
  }
}

export {};
