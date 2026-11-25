import { createContext } from "react";

/** Files the thread already shows as a run's own card: attachment id → that run (see `runFileCardAttachments`). */
export const RunFileCardsContext = createContext<ReadonlyMap<string, string>>(new Map());
