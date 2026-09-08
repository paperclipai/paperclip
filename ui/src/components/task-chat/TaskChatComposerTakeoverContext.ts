import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface TaskChatComposerTakeoverActions {
  skipButton: ReactNode;
  headerSlot: HTMLElement | null;
  controlsSlot: HTMLElement | null;
  setHeaderClaimed: (claimed: boolean) => void;
}

export const TaskChatComposerTakeoverActionsContext =
  createContext<TaskChatComposerTakeoverActions | null>(null);

export function useTaskChatComposerTakeoverActions(): TaskChatComposerTakeoverActions | null {
  return useContext(TaskChatComposerTakeoverActionsContext);
}

/** Moves a takeover's semantic title into the composer's shared top row. */
export function TaskChatComposerTakeoverHeader({
  children,
}: {
  children: ReactNode;
}) {
  const actions = useTaskChatComposerTakeoverActions();
  useLayoutEffect(() => {
    if (!actions) return;
    actions.setHeaderClaimed(true);
    return () => actions.setHeaderClaimed(false);
  }, [actions?.setHeaderClaimed]);

  if (!actions) return children;
  return actions.headerSlot ? createPortal(children, actions.headerSlot) : null;
}

/** Moves pagination or similar compact controls beside pending count and X. */
export function TaskChatComposerTakeoverControls({
  children,
}: {
  children: ReactNode;
}) {
  const actions = useTaskChatComposerTakeoverActions();
  if (!actions) return children;
  return actions.controlsSlot
    ? createPortal(children, actions.controlsSlot)
    : null;
}
