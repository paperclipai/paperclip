import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ConfirmOptions {
  title?: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
}

interface AlertOptions {
  title?: string;
  description: string;
  okLabel?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
type AlertFn = (options: AlertOptions) => Promise<void>;

interface ConfirmContextValue {
  confirm: ConfirmFn;
  alert: AlertFn;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [state, setState] = useState<
    | { mode: "confirm"; options: ConfirmOptions; open: boolean }
    | { mode: "alert"; options: AlertOptions; open: boolean }
    | null
  >(null);
  const resolveRef = useRef<((value: any) => void) | null>(null);

  const confirm: ConfirmFn = useCallback((options) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setState({ mode: "confirm", options, open: true });
    });
  }, []);

  const alert: AlertFn = useCallback((options) => {
    return new Promise<void>((resolve) => {
      resolveRef.current = resolve;
      setState({ mode: "alert", options, open: true });
    });
  }, []);

  const handleClose = useCallback((result: boolean) => {
    setState((prev) => {
      const isAlert = prev?.mode === "alert";
      setTimeout(() => {
        resolveRef.current?.(isAlert ? undefined : result);
        resolveRef.current = null;
        setState(null);
      }, 150);
      return prev ? { ...prev, open: false } : null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={{ confirm, alert }}>
      {children}
      <AlertDialog open={state?.open ?? false} onOpenChange={(open) => { if (!open) handleClose(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {state?.options.title ?? (state?.mode === "confirm" ? t("action.confirm") : t("action.confirm"))}
            </AlertDialogTitle>
            <AlertDialogDescription>{state?.options.description ?? ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {state?.mode === "confirm" && (
              <AlertDialogCancel onClick={() => handleClose(false)}>
                {(state.options as ConfirmOptions).cancelLabel ?? t("action.cancel")}
              </AlertDialogCancel>
            )}
            <AlertDialogAction
              className={
                state?.mode === "confirm" && (state.options as ConfirmOptions).variant === "destructive"
                  ? "bg-destructive text-white hover:bg-destructive/90"
                  : undefined
              }
              onClick={() => handleClose(true)}
            >
              {state?.mode === "confirm"
                ? (state.options as ConfirmOptions).confirmLabel ?? t("action.confirm")
                : (state?.options as AlertOptions)?.okLabel ?? t("action.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx.confirm;
}

export function useAlert(): AlertFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useAlert must be used within ConfirmProvider");
  return ctx.alert;
}
