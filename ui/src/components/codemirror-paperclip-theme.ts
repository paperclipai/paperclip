import { EditorView } from "@codemirror/view";

/**
 * Paperclip dark theme for CodeMirror 6.
 * Matches the zinc/slate design system used across the UI.
 */
export const paperclipDarkTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "oklch(0.145 0 0)", // --background (dark)
      color: "oklch(0.985 0 0)", // --foreground (dark)
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: "14px",
    },
    ".cm-content": {
      caretColor: "oklch(0.985 0 0)",
      padding: "8px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "oklch(0.985 0 0)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "oklch(0.269 0 0 / 0.8)", // --secondary (dark)
    },
    ".cm-activeLine": {
      backgroundColor: "oklch(0.269 0 0 / 0.4)", // subtle highlight
    },
    ".cm-gutters": {
      backgroundColor: "oklch(0.145 0 0)", // match background
      color: "oklch(0.439 0 0)", // --ring (dark) — muted line numbers
      borderRight: "1px solid oklch(0.269 0 0)", // --border (dark)
    },
    ".cm-activeLineGutter": {
      backgroundColor: "oklch(0.269 0 0 / 0.4)",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-line": {
      padding: "0 8px",
    },
  },
  { dark: true },
);

/**
 * Paperclip light theme for CodeMirror 6.
 */
export const paperclipLightTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "oklch(1 0 0)", // --background (light)
      color: "oklch(0.145 0 0)", // --foreground (light)
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: "14px",
    },
    ".cm-content": {
      caretColor: "oklch(0.145 0 0)",
      padding: "8px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "oklch(0.145 0 0)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "oklch(0.97 0 0 / 0.8)", // --secondary (light)
    },
    ".cm-activeLine": {
      backgroundColor: "oklch(0.97 0 0 / 0.6)",
    },
    ".cm-gutters": {
      backgroundColor: "oklch(1 0 0)",
      color: "oklch(0.556 0 0)", // --muted-foreground (light)
      borderRight: "1px solid oklch(0.922 0 0)", // --border (light)
    },
    ".cm-activeLineGutter": {
      backgroundColor: "oklch(0.97 0 0 / 0.6)",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-line": {
      padding: "0 8px",
    },
  },
  { dark: false },
);
