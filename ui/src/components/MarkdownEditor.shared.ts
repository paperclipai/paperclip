export interface MentionOption {
  id: string;
  name: string;
  kind?: "agent" | "project";
  agentId?: string;
  agentIcon?: string | null;
  projectId?: string;
  projectColor?: string | null;
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  contentClassName?: string;
  onBlur?: () => void;
  imageUploadHandler?: (file: File) => Promise<string>;
  /** Called when a non-image file is dropped onto the editor (e.g. .zip). */
  onDropFile?: (file: File) => Promise<void>;
  bordered?: boolean;
  /** List of mentionable entities. Enables @-mention autocomplete. */
  mentions?: MentionOption[];
  /** Called on Cmd/Ctrl+Enter */
  onSubmit?: () => void;
}

export interface MarkdownEditorRef {
  focus: () => void;
}

export interface MentionState {
  trigger: "mention" | "skill";
  marker: "@" | "/";
  query: string;
  top: number;
  left: number;
  /** Viewport-relative coords for portal positioning */
  viewportTop: number;
  viewportLeft: number;
  textNode: Text;
  atPos: number;
  endPos: number;
}

export interface MentionMenuViewport {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
}

interface MentionMenuSize {
  width: number;
  height: number;
}

const MENTION_MENU_WIDTH = 188;
const MENTION_MENU_HEIGHT = 208;
const MENTION_MENU_PADDING = 8;
const MENTION_MENU_ROW_HEIGHT = 34;
const MENTION_MENU_CHROME_HEIGHT = 8;

export function findMentionMatch(
  text: string,
  offset: number,
): Pick<MentionState, "trigger" | "marker" | "query" | "atPos" | "endPos"> | null {
  let atPos = -1;
  let trigger: MentionState["trigger"] | null = null;
  let marker: MentionState["marker"] | null = null;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@" || ch === "/") {
      if (i === 0 || /\s/.test(text[i - 1])) {
        atPos = i;
        trigger = ch === "@" ? "mention" : "skill";
        marker = ch;
      }
      break;
    }
    if (ch === "\n" || ch === "\r") break;
  }

  if (atPos === -1) return null;
  const query = text.slice(atPos + 1, offset);
  if (trigger === "skill" && /\s/.test(query)) return null;

  return {
    trigger: trigger ?? "mention",
    marker: marker ?? "@",
    query,
    atPos,
    endPos: offset,
  };
}

export function computeMentionMenuPosition(
  anchor: Pick<MentionState, "viewportTop" | "viewportLeft">,
  viewport: MentionMenuViewport,
  menuSize: MentionMenuSize = { width: MENTION_MENU_WIDTH, height: MENTION_MENU_HEIGHT },
) {
  const minLeft = viewport.offsetLeft + MENTION_MENU_PADDING;
  const maxLeft = viewport.offsetLeft + viewport.width - menuSize.width;
  const minTop = viewport.offsetTop + MENTION_MENU_PADDING;
  const maxTop = viewport.offsetTop + viewport.height - menuSize.height;

  return {
    top: Math.max(minTop, Math.min(viewport.offsetTop + anchor.viewportTop + 4, maxTop)),
    left: Math.max(minLeft, Math.min(viewport.offsetLeft + anchor.viewportLeft, maxLeft)),
  };
}

export function getMentionMenuSize(optionCount: number): MentionMenuSize {
  const visibleRows = Math.max(1, Math.min(optionCount, 8));
  return {
    width: MENTION_MENU_WIDTH,
    height: Math.min(
      MENTION_MENU_HEIGHT,
      visibleRows * MENTION_MENU_ROW_HEIGHT + MENTION_MENU_CHROME_HEIGHT,
    ),
  };
}
