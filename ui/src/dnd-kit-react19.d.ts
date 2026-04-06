/**
 * Type overrides for @dnd-kit packages whose shipped types return
 * `JSX.Element` (React 18 style).  React 19's stricter `ReactNode`
 * union no longer considers bare `ReactElement` assignable, which
 * causes TS2786 when these components are used as JSX tags.
 *
 * Re-declaring only the specific exports that fail keeps the patch
 * minimal; every other export is still read from the original `.d.ts`.
 */

import type { ReactNode, ReactElement } from "react";

// ---------- @dnd-kit/sortable ----------
declare module "@dnd-kit/sortable" {
  import type { UniqueIdentifier, ClientRect } from "@dnd-kit/core";

  interface Disabled {
    draggable?: boolean;
    droppable?: boolean;
  }

  type SortingStrategy = (args: any) => any;

  interface SortableContextProps {
    children: ReactNode;
    items: (UniqueIdentifier | { id: UniqueIdentifier })[];
    strategy?: SortingStrategy;
    id?: string;
    disabled?: boolean | Disabled;
  }

  export function SortableContext(props: SortableContextProps): ReactElement;
}

// ---------- @dnd-kit/core (DragOverlay) ----------
declare module "@dnd-kit/core" {
  import type { CSSProperties, MemoExoticComponent } from "react";

  interface DragOverlayProps {
    adjustScale?: boolean;
    children?: ReactNode;
    className?: string;
    dropAnimation?: any;
    modifiers?: any;
    style?: CSSProperties;
    transition?: string;
    wrapperElement?: keyof HTMLElementTagNameMap;
    zIndex?: number;
  }

  export const DragOverlay: MemoExoticComponent<
    (props: DragOverlayProps) => ReactElement
  >;
}
