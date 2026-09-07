import * as React from "react";

/**
 * Source-adapted shadcn Dialog rebuilt on the native `<dialog>` element.
 * `showModal()` supplies the focus trap, the backdrop, and Escape-to-close,
 * so no radix runtime and no focus-trap dependency are needed.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const invokingControlRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();

  React.useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (open && !element.open) {
      invokingControlRef.current = document.activeElement as HTMLElement | null;
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      data-slot="dialog"
      className="pcr-dialog"
      aria-labelledby={titleId}
      {...(description === undefined ? {} : { "aria-describedby": descriptionId })}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        onClose();
        invokingControlRef.current?.focus();
      }}
    >
      <form method="dialog" className="pcr-dialog-body">
        <h2 id={titleId} className="pcr-dialog-title">
          {title}
        </h2>
        {description === undefined ? null : (
          <p id={descriptionId} className="pcr-dialog-description">
            {description}
          </p>
        )}
        {children}
        <div className="pcr-dialog-footer">{footer}</div>
      </form>
    </dialog>
  );
}
