import { createContext } from "react";

export const RunFileCardsContext = createContext<ReadonlyMap<string, string>>(new Map());
