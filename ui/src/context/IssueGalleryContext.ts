import { createContext } from "react";

/** Opens media in the task gallery; false lets standalone media use its own viewer. */
export const IssueGalleryContext = createContext<((src: string) => boolean) | null>(null);
