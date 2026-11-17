import { GOOGLE_WORKSPACE_SERVICE_GROUPS, type GoogleWorkspaceServiceSelection } from "@paperclipai/shared";

export const GOOGLE_WORKSPACE_PRIVACY_POLICY_URL = "https://paperclip.ing/privacy";

type ServiceId = (typeof GOOGLE_WORKSPACE_SERVICE_GROUPS)[number]["id"];

const ACCESS: Record<ServiceId, { read: string; write: string }> = {
  gmail: {
    read: "Gmail: agents can read and search your email.",
    write: "Gmail: agents can read and search your email, and create drafts. Google's permission screen also mentions sending email; Paperclip does not send email.",
  },
  drive: {
    read: "Drive: agents can read and search your files, Docs, Sheets and Slides.",
    write: "Drive: agents can read and search your files, Docs, Sheets and Slides. They can also create files and edit Docs, Sheets and Slides.",
  },
  calendar: {
    read: "Calendar: agents can see your calendars, events and free/busy times.",
    write: "Calendar: agents can see your calendars, events and free/busy times. They can also create, change and delete events, and respond to invitations.",
  },
};

const USE = [
  "Agents read this content only to do the tasks you give them.",
  "To do that, the content is sent to the AI model provider configured for your workspace.",
  "It is not used to train general AI models.",
  "Results are saved in the task and its run history. They stay there until you delete them, even after you disconnect.",
];

export function googleWorkspaceDataUseDisclosure(selection: GoogleWorkspaceServiceSelection): { access: string[]; use: string[] } {
  const access = GOOGLE_WORKSPACE_SERVICE_GROUPS.flatMap(group => {
    const level = selection[group.id];
    return level ? [ACCESS[group.id][level]] : [];
  });
  return { access, use: access.length > 0 ? [...USE] : [] };
}
