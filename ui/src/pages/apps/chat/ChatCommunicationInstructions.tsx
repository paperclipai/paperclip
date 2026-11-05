import { useTranslation } from "@/i18n";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { describeError } from "@/api/errors";

export function ChatCommunicationInstructions({ value, onSave }: {
  value: string;
  onSave: (instructions: string) => Promise<void>;
}) {
  const { t } = useTranslation("connections");
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const text = draft ?? value;
  const dirty = text.trim() !== value;
  return (
    <form className="space-y-3" aria-labelledby={`${id}-label`} onSubmit={async (event) => {
      event.preventDefault();
      if (pending || !dirty) return;
      setPending(true);
      setError(null);
      setSaved(false);
      try {
        await onSave(text.trim());
        setDraft(null);
        setSaved(true);
      } catch (cause) {
        setError(describeError(cause).body);
      } finally {
        setPending(false);
      }
    }}>
      <div className="space-y-1">
        <label id={`${id}-label`} htmlFor={id} className="text-sm font-semibold">{t("additional_communication_instructions_679a1cc")}</label>
        <p id={`${id}-help`} className="text-sm text-muted-foreground">{t("applies_to_new_conversations_ef90a8f")}</p>
      </div>
      <Textarea
        id={id}
        aria-describedby={`${id}-help`}
        value={text}
        disabled={pending}
        maxLength={4000}
        rows={4}
        placeholder={t("for_example_keep_replies_brief_and_explain_0d64462")}
        onChange={(event) => { setDraft(event.target.value); setSaved(false); setError(null); }}
      />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-3">
        <div>
          {dirty ? <Button type="button" variant="ghost" disabled={pending} onClick={() => { setDraft(null); setError(null); setSaved(false); }}>{t("cancel_77dfd21")}</Button>
            : saved ? <span role="status" className="text-sm text-muted-foreground">{t("saved_applies_to_new_tasks_761dc09")}</span> : null}
        </div>
        <Button type="submit" disabled={!dirty || pending}>{pending ? t("saving_56a2285") : t("save_instructions_8e0e26d")}</Button>
      </div>
    </form>
  );
}
