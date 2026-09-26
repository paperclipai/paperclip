/**
 * Form primitives for `cursor/canvas`. Provides themed, controlled form controls
 * for interactive canvas apps with persistent state. All `onChange` callbacks
 * receive the **value directly** (not a DOM event), so they pair naturally
 * with `useCanvasState`:
 *
 * ```tsx
 * const [name, setName] = useCanvasState("name", "");
 * <TextInput value={name} onChange={setName} placeholder="Enter name…" />
 * ```
 */
import { type CSSProperties, type JSX, type ReactNode } from "react";
export type TextInputProps = {
    value?: string;
    /** Called with the new string value on every keystroke. */
    onChange?: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    type?: "text" | "email" | "password" | "number" | "url" | "search";
    style?: CSSProperties;
};
/**
 * Single-line text input (28px height). Use for names, titles, search
 * queries, and short text fields.
 *
 * `onChange` receives the **string value**, not a DOM event — this pairs
 * directly with `useCanvasState` setters.
 *
 * @example
 * ```tsx
 * const [name, setName] = useCanvasState("name", "");
 *
 * <TextInput value={name} onChange={setName} placeholder="Task title…" />
 * ```
 */
export declare function TextInput({ value, onChange, placeholder, disabled, type, style }: TextInputProps): JSX.Element;
export type TextAreaProps = {
    value?: string;
    /** Called with the new string value on every keystroke. */
    onChange?: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    /** Minimum visible rows. Defaults to 3. */
    rows?: number;
    style?: CSSProperties;
};
/**
 * Multi-line text input that auto-resizes to fit its content.
 * Use for notes, descriptions, comments, and multi-line text fields.
 *
 * The textarea grows as the user types. Set `rows` for the minimum visible
 * height (defaults to 3). Override with `style={{ height: "100px" }}` for a
 * fixed size.
 *
 * @example
 * ```tsx
 * const [notes, setNotes] = useCanvasState("notes", "");
 *
 * <TextArea value={notes} onChange={setNotes} placeholder="Add notes…" rows={4} />
 * ```
 */
export declare function TextArea({ value, onChange, placeholder, disabled, rows, style }: TextAreaProps): JSX.Element;
export type CheckboxProps = {
    checked?: boolean;
    /** Called with the new boolean value when toggled. */
    onChange?: (checked: boolean) => void;
    disabled?: boolean;
    /** Optional label rendered beside the checkbox. Clicking the label toggles the checkbox. */
    label?: ReactNode;
    style?: CSSProperties;
};
/**
 * Checkbox with optional label (accent blue when checked).
 *
 * Pass `label` to render a clickable text label beside the checkbox. Without a
 * label, provide `title` or wrap in your own `<label>` for accessibility.
 *
 * @example
 * ```tsx
 * const [agreed, setAgreed] = useCanvasState("agreed", false);
 *
 * <Checkbox checked={agreed} onChange={setAgreed} label="I agree to the terms" />
 * ```
 *
 * @example
 * ```tsx
 * // Checkbox in a list — no label, parent handles layout
 * <Checkbox checked={item.done} onChange={(v) => toggleItem(item.id, v)} />
 * ```
 */
export declare function Checkbox({ checked, onChange, disabled, label, style }: CheckboxProps): JSX.Element;
export type ToggleProps = {
    checked?: boolean;
    /** Called with the new boolean value when toggled. */
    onChange?: (checked: boolean) => void;
    disabled?: boolean;
    /** `sm` = 16px track, `md` = 20px track (default `sm`). */
    size?: "sm" | "md";
    style?: CSSProperties;
};
/**
 * Boolean toggle switch. Uses the accent color for the "on" state and a
 * neutral fill for "off".
 *
 * @example
 * ```tsx
 * const [enabled, setEnabled] = useCanvasState("enabled", false);
 *
 * <Row gap={8} align="center">
 *   <Text>Notifications</Text>
 *   <Spacer />
 *   <Toggle checked={enabled} onChange={setEnabled} />
 * </Row>
 * ```
 */
export declare function Toggle({ checked, onChange, disabled, size, style }: ToggleProps): JSX.Element;
export type SelectOption = {
    value: string;
    label: string;
    disabled?: boolean;
};
export type SelectProps = {
    value?: string;
    /** Called with the new selected value. */
    onChange?: (value: string) => void;
    /** List of options. Each must have a unique `value`. */
    options: SelectOption[];
    /** Placeholder shown when no value is selected. */
    placeholder?: string;
    disabled?: boolean;
    style?: CSSProperties;
};
/**
 * Dropdown select (native `<select>` with themed styling).
 *
 * Uses a native `<select>` under the hood for reliable keyboard, screen-reader,
 * and mobile support. The dropdown list uses OS-native styling.
 *
 * @example
 * ```tsx
 * const [priority, setPriority] = useCanvasState("priority", "medium");
 *
 * <Select
 *   value={priority}
 *   onChange={setPriority}
 *   options={[
 *     { value: "low", label: "Low" },
 *     { value: "medium", label: "Medium" },
 *     { value: "high", label: "High" },
 *   ]}
 * />
 * ```
 */
export declare function Select({ value, onChange, options, placeholder, disabled, style }: SelectProps): JSX.Element;
export type IconButtonProps = {
    /** Icon content: an SVG element, emoji, or unicode character. */
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    /** Tooltip text. Always provide for accessibility since there is no text label. */
    title?: string;
    /**
     * `"default"` is transparent until hovered; `"circle"` has a permanent
     * background fill.
     */
    variant?: "default" | "circle";
    /** `sm` = 16px, `md` = 20px (default `md`). */
    size?: "sm" | "md";
    style?: CSSProperties;
};
/**
 * Compact icon-only button for inline actions on list items (delete, edit,
 * expand, etc.). Accepts **any** `children` as the icon — use an inline SVG,
 * an emoji, or a unicode character.
 *
 * Always provide `title` for accessibility (screen-reader label + tooltip).
 *
 * Canvas has no icon font, so pass icon content directly.
 *
 * @example
 * ```tsx
 * // Delete button on a card
 * <IconButton title="Delete" onClick={() => remove(id)}>✕</IconButton>
 *
 * // Edit button with an SVG icon
 * <IconButton title="Edit" variant="circle" size="sm" onClick={edit}>
 *   <svg width={12} height={12} viewBox="0 0 12 12" fill="none">
 *     <path d="M8.5 1.5l2 2L4 10H2V8z" stroke="currentColor" strokeWidth={1.2} />
 *   </svg>
 * </IconButton>
 * ```
 */
export declare function IconButton({ children, onClick, disabled, title, variant, size, style }: IconButtonProps): JSX.Element;
//# sourceMappingURL=form-primitives.d.ts.map