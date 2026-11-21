import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, LoaderCircle, Trash2 } from "lucide-react";
import { MAX_AGENT_AVATAR_BYTES, type AgentAppearance } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { describeError } from "../api/errors";
import { Button } from "@/components/ui/button";
import { useAgentPhotoEditorState } from "./AgentPhotoFrame";

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export type PortraitAgent = {
  id: string;
  companyId: string;
  name: string;
  status?: string;
  appearance?: AgentAppearance | null;
};

export function avatarFileError(file: File): string | null {
  const type = file.type.toLowerCase();
  const namedOk = /\.(png|jpe?g|webp)$/i.test(file.name);
  if (type && !ACCEPTED_TYPES.has(type)) return "Use a PNG, JPEG, or WebP image";
  if (!type && !namedOk) return "Use a PNG, JPEG, or WebP image";
  if (file.size <= 0 || file.size > MAX_AGENT_AVATAR_BYTES) return "Image must be 512 KB or smaller";
  return null;
}

export async function fileToAvatarBase64(file: File): Promise<string> {
  const problem = avatarFileError(file);
  if (problem) throw new Error(problem);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function AgentPortraitControls({ agent }: { agent: PortraitAgent }) {
  const inputId = useId();
  const queryClient = useQueryClient();
  const editor = useAgentPhotoEditorState();
  const [localError, setLocalError] = useState<string | null>(null);
  const hasPhoto = Boolean(agent.appearance?.customAvatarAssetId);
  const locked = agent.status === "terminated" || agent.status === "pending_approval";

  const mutation = useMutation({
    mutationFn: (imageBase64: string | null) => agentsApi.setAvatar(agent.companyId, agent.id, imageBase64),
    onSuccess: async () => {
      setLocalError(null);
      editor?.clearError();
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (error) => {
      setLocalError(describeError(error, { action: "save the agent photo" }).body);
    },
  });

  async function onFile(file: File | undefined) {
    if (!file) return;
    const problem = avatarFileError(file);
    if (problem) {
      setLocalError(problem);
      return;
    }
    setLocalError(null);
    const imageBase64 = await fileToAvatarBase64(file);
    mutation.mutate(imageBase64);
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          data-testid="agent-photo-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
          className="sr-only"
          disabled={locked || mutation.isPending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void onFile(file);
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={locked || mutation.isPending}
          onClick={() => document.getElementById(inputId)?.click()}
        >
          {mutation.isPending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
          {hasPhoto ? "Change photo" : "Upload photo"}
        </Button>
        {hasPhoto ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="remove-agent-photo"
            disabled={locked || mutation.isPending}
            onClick={() => mutation.mutate(null)}
          >
            <Trash2 className="size-3.5" />
            Remove photo
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {hasPhoto
          ? editor?.movable
            ? "Drag the photo to center it. Arrow keys move it too. Remove it to use the character logo again."
            : "This photo is stored with the Paperclip installation. Remove it to use the character logo again."
          : "Choose a PNG, JPEG, or WebP up to 512 KB. It is copied into this Paperclip installation."}
      </p>
      {localError || editor?.error ? <p className="text-xs text-destructive">{localError ?? editor?.error}</p> : null}
    </div>
  );
}
