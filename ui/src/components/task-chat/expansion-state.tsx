import { createContext, useCallback, useContext, useState, type Dispatch, type SetStateAction } from "react";

// A phase can move from the live tail into persisted history. Its expansion
// belongs to the logical phase, not whichever component currently hosts it.
export const TaskChatExpansionState = createContext<Map<string, boolean> | null>(null);

export function useTaskChatExpansion(id: string, initial: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
  const memory = useContext(TaskChatExpansionState);
  const [open, setOpen] = useState(() => memory?.get(id) ?? initial);
  const update = useCallback<Dispatch<SetStateAction<boolean>>>((value) => {
    setOpen((previous) => {
      const next = typeof value === "function" ? value(previous) : value;
      memory?.set(id, next);
      return next;
    });
  }, [id, memory]);
  return [open, update];
}
