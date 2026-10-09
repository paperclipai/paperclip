import type { Meta, StoryObj } from "@storybook/react-vite";
import { AnnouncementCard } from "@/components/AnnouncementCard";
import { announcementPreview, announcementAnimationPreview, announcementAnimationPreviewSrc } from "@/lib/announcement-preview";

const meta = {
  title: "Announcements/AnnouncementCard",
  component: AnnouncementCard,
  args: { announcement: announcementPreview, imageSrc: "/announcement-preview.svg", onDismiss: () => {} },
  decorators: [(Story) => <div className="p-4"><Story /></div>],
} satisfies Meta<typeof AnnouncementCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Dark: Story = { globals: { theme: "dark" } };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } } };
export const MissingImage: Story = { args: { imageSrc: "/missing-announcement-image.png" } };
export const TextOnly: Story = { args: { announcement: { ...announcementPreview, image: undefined, secondaryLink: undefined } } };
export const LongText: Story = {
  args: { announcement: { ...announcementPreview, title: "Give your most ambitious ideas a team that can carry them forward", description: "Organize your agents around a shared goal, bring the work into one place, and keep every decision connected to its context. Follow progress, review outcomes, and help your team take the next step whenever it needs your direction.", primaryAction: { kind: "external", label: "See everything that’s new in Paperclip", url: "https://paperclip.ing" } } },
};

export const Animated: Story = { args: { announcement: announcementAnimationPreview, animationSrc: announcementAnimationPreviewSrc } };
export const AnimatedDark: Story = { ...Animated, globals: { theme: "dark" } };
export const AnimatedMobile: Story = { ...Animated, globals: { viewport: { value: "mobile1", isRotated: false } } };
export const MissingAnimation: Story = { args: { announcement: announcementAnimationPreview, animationSrc: "/missing-announcement-animation.html" } };
