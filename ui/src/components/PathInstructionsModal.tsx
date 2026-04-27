import { useState } from "react";
import { Apple, Monitor, Terminal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Platform = "mac" | "windows" | "linux";

const platforms: { id: Platform; label: string; icon: typeof Apple }[] = [
  { id: "mac", label: "macOS", icon: Apple },
  { id: "windows", label: "Windows", icon: Monitor },
  { id: "linux", label: "Linux", icon: Terminal },
];

const instructions: Record<Platform, { steps: string[]; tip?: string }> = {
  mac: {
    steps: [
      "Abra o Finder e navegue até a pasta.",
      "Clique com o botão direito (ou Control-clique) na pasta.",
      "Segure a tecla Option (⌥) — \"Copiar\" muda para \"Copiar como Caminho\".",
      "Clique em \"Copiar como Caminho\" e cole aqui.",
    ],
    tip: "Você também pode abrir o Terminal, digitar cd, arrastar a pasta para a janela do terminal e pressionar Enter. Depois digite pwd para ver o caminho completo.",
  },
  windows: {
    steps: [
      "Abra o Explorador de Arquivos e navegue até a pasta.",
      "Clique na barra de endereço no topo — o caminho completo aparecerá.",
      "Copie o caminho e cole aqui.",
    ],
    tip: "Alternativamente, segure Shift e clique com o botão direito na pasta, depois selecione \"Copiar como caminho\".",
  },
  linux: {
    steps: [
      "Abra um terminal e navegue até o diretório com cd.",
      "Execute pwd para exibir o caminho completo.",
      "Copie a saída e cole aqui.",
    ],
    tip: "Na maioria dos gerenciadores de arquivos, Ctrl+L revela o caminho completo na barra de endereço.",
  },
};

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "mac";
  if (ua.includes("win")) return "windows";
  return "linux";
}

interface PathInstructionsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PathInstructionsModal({
  open,
  onOpenChange,
}: PathInstructionsModalProps) {
  const [platform, setPlatform] = useState<Platform>(detectPlatform);

  const current = instructions[platform];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Como obter o caminho completo</DialogTitle>
          <DialogDescription>
            Cole o caminho absoluto (ex.{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">/Users/you/project</code>
            ) no campo de entrada.
          </DialogDescription>
        </DialogHeader>

        {/* Platform tabs */}
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          {platforms.map((p) => (
            <button
              key={p.id}
              type="button"
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                platform === p.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
              onClick={() => setPlatform(p.id)}
            >
              <p.icon className="h-3.5 w-3.5" />
              {p.label}
            </button>
          ))}
        </div>

        {/* Steps */}
        <ol className="space-y-2 text-sm">
          {current.steps.map((step, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted-foreground font-mono text-xs mt-0.5 shrink-0">
                {i + 1}.
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        {current.tip && (
          <p className="text-xs text-muted-foreground border-l-2 border-border pl-3">
            {current.tip}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Small "Choose" button that opens the PathInstructionsModal.
 * Drop-in replacement for the old showDirectoryPicker buttons.
 */
export function ChoosePathButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={cn(
          "inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0",
          className,
        )}
        onClick={() => setOpen(true)}
      >
        Escolher
      </button>
      <PathInstructionsModal open={open} onOpenChange={setOpen} />
    </>
  );
}
