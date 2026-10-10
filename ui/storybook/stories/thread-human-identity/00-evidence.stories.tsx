import type { Meta, StoryObj } from "@storybook/react-vite";
import { humanMessages, profiles } from "./fixtures";
function ReviewGuide() {
  return <main className="mx-auto max-w-5xl space-y-6 p-6 text-foreground">
    <h1 className="text-xl font-semibold">Human identity in a mixed task conversation</h1>
    <p>Two human users and an agent can contribute to the same task. Previously every human comment used the same blue, right-aligned style without a name or avatar. Other people’s messages looked like the viewer’s own messages.</p>
    <table className="w-full text-left text-sm"><thead><tr><th className="p-2">Example message</th><th className="p-2">Author</th></tr></thead><tbody>{humanMessages.map(row => <tr key={row.id} className="border-t border-border"><td className="p-2">{row.body}</td><td className="p-2">{profiles.get(row.authorUserId)?.label}</td></tr>)}</tbody></table>
    <p>IssueDetail builds companyUserProfileMap from user-directory records and obtains currentUserId from the session. TaskChatThread received both, but only passed userLabelMap to the adapter. The normalized message discarded authorUserId, profile.image, and viewer ownership. TaskChatBubble rendered identity only for agents.</p>
    <p>The change carries those fields through the production adapter and displays the shared Identity component for other humans. Agents and other humans sit on the left on the page surface with an avatar and name. Only the viewer’s own messages remain blue and right-aligned. Unknown profiles say User. Missing or externally hosted photos show initials. Profile refreshes are included in the adapter memo dependencies.</p>
    <p>These are representative fixtures, not a copy of private task data. The mixed journey uses the production shell, adapter, thread, and composer. Swap the viewer to verify that ownership follows authorUserId. Full Conversation includes all fixture messages. Sending is local to the preview.</p>
  </main>;
}
export default { title: "Chat & Comments/Human identity/00 Review guide", component: ReviewGuide } satisfies Meta<typeof ReviewGuide>;
export const DataFlow: StoryObj<typeof ReviewGuide> = {};
