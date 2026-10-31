import { useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Props = Pick<ComponentProps<typeof Input>, "type" | "aria-label" | "autoComplete" | "value" | "placeholder" | "className" | "disabled"> & {
  configPath: string;
  onChange: (value: string) => void;
};

export function ConnectionCredentialInput({ configPath, onChange, type = "password", ...props }: Props) {
  const [visible, setVisible] = useState(false);
  if (configPath === "credentials.privateKey") {
    return <div>
      <Textarea
        {...props}
        className={[props.className, visible ? "" : "secret-textarea"].filter(Boolean).join(" ")}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        autoCorrect="off"
        autoCapitalize="off"
        data-private="true"
      />
      <Button type="button" variant="ghost" size="sm" disabled={props.disabled}
        aria-pressed={visible} onClick={() => setVisible((current) => !current)}>
        {visible ? "Hide private key" : "Show private key"}
      </Button>
      <p className="mt-2 text-xs text-muted-foreground">
        Connecting automatically stores this key as an encrypted secret in Paperclip’s vault.
        The saved value is never displayed again.
      </p>
    </div>;
  }
  return <Input {...props} type={type} onChange={(event) => onChange(event.target.value)} />;
}
