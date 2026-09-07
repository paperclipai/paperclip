import { t, useTranslation } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";
import {
  MarkdownEditor,
  type MarkdownEditorRef,
  type MentionOption,
} from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";

interface TaskChatRichInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  imageUploadHandler?: (file: File) => Promise<string>;
  mentions?: MentionOption[];
  disabled?: boolean;
  autoFocus?: boolean;
  onSubmit?: () => void;
  onUploadingChange?: (uploading: boolean) => void;
  ariaLabelledBy?: string;
  testId?: string;
  attachAriaLabel?: string;
  showImageAttachControls?: boolean;
}

/** Composer-grade rich text field for takeover answers and revision notes. */
export function TaskChatRichInput({
  value,
  onChange,
  placeholder,
  imageUploadHandler,
  mentions,
  disabled = false,
  autoFocus = false,
  onSubmit,
  onUploadingChange,
  ariaLabelledBy,
  testId = "task-chat-rich-input",
  attachAriaLabel = t("localizationTaskRuntime.ui_Attach_image_1cuilex"),
  showImageAttachControls = true,
}: TaskChatRichInputProps) {
  useTranslation();
  const editorRef = useRef<MarkdownEditorRef>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadCountRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  function updateUploading(next: boolean) {
    setUploading(next);
    onUploadingChange?.(next);
  }

  async function uploadImage(file: File): Promise<string> {
    if (!imageUploadHandler) throw new Error(t("localizationTaskRuntime.ui_Image_uploads_are_unavailable_1tm0dbm"));
    uploadCountRef.current += 1;
    updateUploading(true);
    setUploadError(null);
    try {
      return await imageUploadHandler(file);
    } catch (error) {
      setUploadError(
        error instanceof Error
          ? error.message
          : t("localizationTaskRuntime.ui_The_image_could_not_be_uploaded_t4p3hw"),
      );
      throw error;
    } finally {
      uploadCountRef.current = Math.max(0, uploadCountRef.current - 1);
      if (uploadCountRef.current === 0) updateUploading(false);
    }
  }

  async function chooseImage(file: File | null) {
    if (!file) return;
    try {
      const url = await uploadImage(file);
      const alt = (file.name || "image").replace(/[[\]]/g, "\\$&");
      editorRef.current?.insertMarkdown(`\n\n![${alt}](${url})\n\n`);
    } catch {
      // uploadImage owns the visible error state.
    }
  }

  return (
    <div
      className="rounded-md bg-muted/35 px-3 py-2"
      role="group"
      aria-labelledby={ariaLabelledBy}
      data-testid={testId}
    >
      <MarkdownEditor
        ref={editorRef}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        imageUploadHandler={imageUploadHandler ? uploadImage : undefined}
        mentions={mentions}
        readOnly={disabled}
        onSubmit={onSubmit}
        bordered={false}
        contentClassName="max-h-(--sz-28dvh) min-h-(--sz-72px) overflow-y-auto px-0 py-0 text-sm scrollbar-auto-hide"
      />
      {imageUploadHandler && showImageAttachControls ? (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label={attachAriaLabel}
            onChange={(event) => {
              void chooseImage(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="-ml-2 h-7 px-2"
            disabled={disabled || uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ImagePlus aria-hidden className="h-3.5 w-3.5" />
            )}
            {t("localizationTaskRuntime.ui_Attach_image_1cuilex")}
          </Button>
          <span>{t("localizationTaskRuntime.ui_or_drop_paste_an_image_into_the_note_1lg8kie")}</span>
        </div>
      ) : null}
      {uploadError ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {uploadError}
        </p>
      ) : null}
    </div>
  );
}
