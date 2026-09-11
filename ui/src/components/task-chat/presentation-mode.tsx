import { createContext, useContext, type ReactNode } from "react";

export type TaskChatPresentationMode = "production" | "streamlined";

// Isolated component previews/tests render the new presentation by default.
// The live TaskChatThread always provides an explicit instance-setting mode.
const TaskChatPresentationContext = createContext<TaskChatPresentationMode>("streamlined");

export function TaskChatPresentationProvider({
  mode,
  children,
}: {
  mode: TaskChatPresentationMode;
  children: ReactNode;
}) {
  return (
    <TaskChatPresentationContext.Provider value={mode}>
      {children}
    </TaskChatPresentationContext.Provider>
  );
}

export function useStreamlinedTaskChatPresentation(): boolean {
  return useContext(TaskChatPresentationContext) === "streamlined";
}
