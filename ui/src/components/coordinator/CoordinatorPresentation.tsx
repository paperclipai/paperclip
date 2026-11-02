import { createContext, useContext } from "react";

/** Presentation context is cheap enough to read in every transcript message.
 * The shell alone resolves the saved experimental preference. */
export const CoordinatorPresentation = createContext(false);
export const useCoordinatorPresentation = () => useContext(CoordinatorPresentation);
