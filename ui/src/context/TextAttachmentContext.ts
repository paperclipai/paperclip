import { createContext } from "react";

/** The task owns panel visibility; callers retain their normal link fallback. */
export const TextAttachmentContext = createContext<((id: string, title: string) => void) | null>(null);
