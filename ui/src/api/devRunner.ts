import { resolveDevRunnerRestartUrl } from "@paperclipai/shared";
import { ApiError, api } from "./client";

type RestartResponse = {
  accepted: boolean;
  requestId: string;
  requestedAt: string;
};

async function readApiError(response: Response): Promise<ApiError> {
  const errorBody = await response.json().catch(() => null);
  return new ApiError(
    (errorBody as { error?: string } | null)?.error ?? `Request failed: ${response.status}`,
    response.status,
    errorBody,
  );
}

async function postRunnerControlRestart(url: string): Promise<RestartResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
    },
    body: "",
  });
  if (!response.ok) {
    throw await readApiError(response);
  }
  return response.json();
}

export const devRunnerApi = {
  restart: async (): Promise<RestartResponse> => {
    try {
      return await api.post<RestartResponse>("/instance/dev-server/restart", {});
    } catch (error) {
      if (error instanceof ApiError && error.status !== 404) {
        throw error;
      }
    }

    const restartUrl =
      typeof window === "undefined" ? null : resolveDevRunnerRestartUrl(window.location.origin);
    if (!restartUrl) {
      throw new Error("Managed dev-server restart is unavailable in this browser context");
    }
    return await postRunnerControlRestart(restartUrl);
  },
};
