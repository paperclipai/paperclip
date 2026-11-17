/**
 * The lip — the one physical edge every surface shares (tokens.css, "the lip").
 *
 * A strip of the ground's own material, lit along its top, throwing a crisp
 * shadow on whatever stands behind it. An object's foot is always a few px
 * behind it (`STAND`), so a tilted corner never floats.
 *
 *   LIP    the front of a tray, across its bottom edge: a thread row, a stack
 *          of one, the panel's rail. `LIP_CLIP` is the box to put it in when
 *          the tray has round corners (with the tray's own radius): the tray
 *          itself cannot clip, because what stands in it stands proud of it.
 *   LEDGE  the same strip under one object's holder, running out sideways to
 *          the edges of the tray it is on — which must clip it on the x axis
 *          (`overflow-x-clip`). Every holder in a row draws the same line, so
 *          a row of objects stands on one continuous ledge however the row
 *          wraps: the attachments tray, an opened stack's rows.
 */
export const LIP = "pointer-events-none absolute inset-x-0 bottom-0 z-20 block h-(--tac-lip-h) bg-(--tac-ledge) bg-(image:--tac-board-grain) shadow-(--tac-ledge-edge)";

export const LIP_CLIP = "pointer-events-none absolute inset-0 z-20 block overflow-hidden";

export const LEDGE =
  "relative after:pointer-events-none after:absolute after:-inset-x-(--tac-run) after:top-full after:z-20 after:block after:h-(--tac-lip-h) after:bg-(--tac-ledge) after:bg-(image:--tac-board-grain) after:shadow-(--tac-shelf-edge)";

/** On whatever stands behind a lip or on a ledge: its foot goes down behind the strip. */
export const STAND = "translate-y-(--tac-lip-tuck)";

/** Cuts a standing object and its shadow at the foot of its holder (inline `style`), so neither shows below the lip. */
export const STAND_CLIP = { clipPath: "var(--tac-clip-stand)" } as const;
