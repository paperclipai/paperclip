import type { BoardBootstrap } from "@paperclipai/shared";
import { accessApi } from "./access";
import { ApiError, detachInflightGet } from "./client";
import { queryKeys } from "../lib/queryKeys";

export function boardAccessQueryOptions(
  userId: string | null,
  bootstrap: BoardBootstrap | undefined,
  updatedAt: number,
  onAccountChanged: () => void,
  onAccessDenied?: () => void,
  onAccessVerified?: (snapshot: unknown) => void,
  captureAccessSnapshot?: () => unknown,
) {
  const initialData = userId && bootstrap?.userId === userId && bootstrap.boardAccess.userId === userId
    ? bootstrap.boardAccess
    : undefined;
  return {
    queryKey: [...queryKeys.access.currentBoardAccess, userId] as const,
    initialData,
    initialDataUpdatedAt: initialData ? updatedAt : undefined,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<BoardBootstrap["boardAccess"]> => {
      signal.throwIfAborted();
      const snapshot = captureAccessSnapshot?.();
      // Path-only request coalescing must not join reads from two accounts.
      detachInflightGet("/cli-auth/me");
      let access: Awaited<ReturnType<typeof accessApi.getCurrentBoardAccess>>;
      try {
        access = await accessApi.getCurrentBoardAccess(signal);
        signal.throwIfAborted();
      } catch (error) {
        if (!signal.aborted && error instanceof ApiError && (error.status === 401 || error.status === 403)) onAccessDenied?.();
        if (!signal.aborted && error instanceof ApiError && error.status === 401) onAccountChanged();
        throw error;
      }
      if (access.userId !== userId) {
        onAccountChanged();
        throw new ApiError("The signed-in account changed. Checking your session again.", 401, { code: "session_changed" });
      }
      onAccessVerified?.(snapshot);
      return { userId: access.userId, isInstanceAdmin: access.isInstanceAdmin, companyIds: access.companyIds };
    },
  };
}
