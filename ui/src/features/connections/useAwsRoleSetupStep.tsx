import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ToolConnection } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { AwsRoleSetup, awsSetupErrorMessage } from "./AwsRoleSetup";

/**
 * The AWS role setup sequence, owned here so the shared connect flow only asks
 * for request options, hands back results, and renders the step:
 * the first Connect saves a draft (reusing one saved earlier) without a role ARN,
 * the AWS step shows how to create the role, and Test connection resumes the
 * draft with the role ARN the customer pasted back. Reconnect opens the same
 * step for the existing connection, so its role ARN can change.
 */
export function useAwsRoleSetupStep({ appSlug, methodKey, reconnectConnectionId, resumeConnection }: {
  appSlug: string | undefined;
  methodKey: string | null | undefined;
  reconnectConnectionId: string | null;
  /** The connection the flow was opened to resume, if any. */
  resumeConnection: Pick<ToolConnection, "id" | "status" | "config"> | null;
}) {
  const { selectedCompanyId } = useCompany();
  const [stage, setStage] = useState<{ connectionId: string; error: string | null } | null>(null);
  // The draft this setup saved (kept across Back, so Connect updates it) and whether the next connect is the test.
  const draft = useRef<{ id: string | null; testing: boolean; roleArn: string | null }>({ id: null, testing: false, roleArn: null });
  const awsRole = appSlug === "aws" && methodKey === "aws-role";
  const active = awsRole && !reconnectConnectionId;
  const resumingDraft = resumeConnection?.status === "draft"
    && resumeConnection.config?.sourceTemplateKey === "aws"
    && resumeConnection.config?.connectionMethodKey === "aws-role";

  // Coming back to an unfinished draft reopens the step (once), before anything is tested against AWS.
  useEffect(() => {
    if (!resumingDraft || !resumeConnection || draft.current.id === resumeConnection.id) return;
    draft.current = { id: resumeConnection.id, testing: false, roleArn: null };
    setStage({ connectionId: resumeConnection.id, error: null });
  }, [resumingDraft, resumeConnection]);

  // Leaving AWS role (another app or method) drops the step and its draft.
  useEffect(() => {
    if ((appSlug && appSlug !== "aws") || (methodKey && methodKey !== "aws-role")) {
      setStage(null);
      draft.current = { id: null, testing: false, roleArn: null };
    }
  }, [appSlug, methodKey]);

  return {
    /**
     * True when Connect should open the AWS step instead of sending a request: reconnecting
     * an AWS role connection shows the step (with its saved role ARN) before anything is tested.
     */
    openForReconnect(): boolean {
      if (!awsRole || !reconnectConnectionId || draft.current.testing) return false;
      draft.current = { id: reconnectConnectionId, testing: false, roleArn: null };
      setStage({ connectionId: reconnectConnectionId, error: null });
      return true;
    },
    /** Extra connect request fields; call once per connect. */
    requestOptions(resumeConnectionId: string | null | undefined): {
      saveDraft?: true; resumeConnectionId?: string; configValues?: { roleArn: string };
    } {
      const { testing, roleArn } = draft.current;
      draft.current.testing = false;
      if (awsRole && reconnectConnectionId) return testing && roleArn ? { configValues: { roleArn } } : {};
      if (!active) return {};
      const saveDraft = (!resumeConnectionId || resumingDraft) && !testing;
      const resumeId = !resumeConnectionId ? draft.current.id : null;
      return {
        ...(saveDraft ? { saveDraft: true as const } : {}),
        ...(resumeId ? { resumeConnectionId: resumeId } : {}),
        ...(testing && roleArn ? { configValues: { roleArn } } : {}),
      };
    },
    /** True when a connect result is this setup's saved draft, which opens the AWS step. */
    acceptResult(result: { connectionId: string; connection?: { status?: string } | null; catalog: unknown[] }): boolean {
      if (appSlug !== "aws" || result.connection?.status !== "draft" || result.catalog.length > 0) return false;
      draft.current.id = result.connectionId;
      setStage({ connectionId: result.connectionId, error: null });
      return true;
    },
    /** True when a failed connect was this step's test; the error is shown in place. */
    acceptError(error: unknown): boolean {
      if (!stage) return false;
      setStage({ ...stage, error: awsSetupErrorMessage(error) });
      return true;
    },
    /** `accessLevel` is the form's choice, which the test submits, so the guide matches it. */
    renderStep({ testing, connect, accessLevel }: {
      testing: boolean; connect: () => void; accessLevel?: "read_only" | "full";
    }): ReactNode | undefined {
      if (appSlug !== "aws" || !stage) return undefined;
      return (
        <AwsRoleSetup
          connectionId={stage.connectionId}
          companyId={selectedCompanyId}
          accessLevel={accessLevel}
          error={stage.error}
          testing={testing}
          onBack={() => setStage(null)}
          onTest={(roleArn) => {
            setStage({ ...stage, error: null });
            draft.current = { id: stage.connectionId, testing: true, roleArn };
            connect();
          }}
        />
      );
    },
  };
}
