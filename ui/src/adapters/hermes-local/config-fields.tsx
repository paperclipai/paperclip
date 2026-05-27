import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { useLocalizedCopy } from "../../i18n/ui-copy";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

export function HermesLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  const copy = useLocalizedCopy();
  if (hideInstructionsFile) return null;
  return (
    <>
      <Field label={copy("hermesLocal.instructionsFile", "Agent instructions file", "직원 지침 파일")} hint={instructionsFileHint}>
        <div className="flex items-center gap-2">
          <DraftInput
            value={
              isCreate
                ? values!.instructionsFilePath ?? ""
                : eff(
                    "adapterConfig",
                    "instructionsFilePath",
                    String(config.instructionsFilePath ?? ""),
                  )
            }
            onCommit={(v) =>
              isCreate
                ? set!({ instructionsFilePath: v })
                : mark("adapterConfig", "instructionsFilePath", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="/absolute/path/to/AGENTS.md"
          />
          <ChoosePathButton />
        </div>
      </Field>
      <div className="border border-border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">
        <div className="font-medium text-foreground">
          {copy("hermesLocal.telegram.title", "Telegram command channel", "Telegram 지시 채널")}
        </div>
        <div className="mt-1">
          {copy(
            "hermesLocal.telegram.description",
            "Paperclip can run Hermes now. Telegram commands require a separate Hermes gateway/bot configuration before they can dispatch work safely.",
            "현재 Paperclip에서 Hermes 실행은 가능합니다. Telegram 업무 지시는 별도 Hermes gateway/bot 설정 후 안전하게 작업으로 전달할 수 있습니다.",
          )}
        </div>
      </div>
    </>
  );
}
