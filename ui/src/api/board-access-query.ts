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
) {
  const initialData = userId && bootstrap?.userId === userId && bootstrap.boardAccess.userId === userId
    ? bootstrap.boardAccess
    : undefined;
  return {
    queryKey: [...queryKeys.access.currentBoardAccess, userId] as const,
    initialData,
    initialDataUpdatedAt: initialData ? updatedAt : undefined,
    queryFn: async (): Promise<BoardBootstrap["boardAccess"]> => {
      // Path-only request coalescing must not join reads from two accounts.
      detachInflightGet("/cli-auth/me");
      let access: Awaited<ReturnType<typeof accessApi.getCurrentBoardAccess>>;
      try {
        access = await accessApi.getCurrentBoardAccess();
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) onAccessDenied?.();
        if (error instanceof ApiError && error.status === 401) onAccountChanged();
        throw error;
      }
      if (access.userId !== userId) {
        onAccountChanged();
        throw new ApiError("The signed-in account changed. Checking your session again.", 401, { code: "session_changed" });
      }
      return { userId: access.userId, isInstanceAdmin: access.isInstanceAdmin, companyIds: access.companyIds };
    },
  };
}
