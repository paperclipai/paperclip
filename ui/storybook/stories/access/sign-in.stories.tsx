import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { AuthPage } from "@/pages/Auth";
import { Companies } from "@/pages/Companies";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { storybookAuthSession } from "../../fixtures/paperclipData";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
function SignIn() {
  return (
    <Routes>
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/companies" element={<Companies />} />
      <Route path="/PAP/companies" element={<Companies />} />
    </Routes>
  );
}
const meta = {
  id: "feature-sign-in",
  title: "Getting started and access/Login, invitations, and access/Sign in",
  component: SignIn,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/auth?next=/companies"],
    paperclip: {
      "capabilities": [
        "access/login"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "AuthPage email form, session read loading/error, submission pending/failure and navigation to Companies after a fixture session. Real authentication, bootstrap claim and sign-out remain separate."
    },
  },
  beforeEach: ({ parameters }) => {
    let session: unknown = null;
    return prepareFixtureApi(
      [
        {
          path: "/api/health",
          state: "ready",
          read: () => ({
            status: "ok",
            deploymentMode: "authenticated",
            authReady: true,
          }),
        },
        { path: "/api/auth/get-session", read: () => session },
        {
          path: "/api/auth/sign-in/email",
          method: "POST",
          read: () => {
            session = storybookAuthSession;
            return { user: storybookAuthSession.user, token: "fixture-only" };
          },
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof SignIn>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedOut: Story = {};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const SessionFailed: Story = { parameters: { fixtureState: "failure" } };
async function submit(canvasElement: HTMLElement) {
  const c = within(canvasElement);
  const email = await c.findByRole("textbox", { name: "Email" });
  await userEvent.clear(email);
  await userEvent.click(email);
  await userEvent.paste("reviewer@example.test");
  const password = c.getByLabelText("Password");
  await userEvent.clear(password);
  await userEvent.click(password);
  await userEvent.paste("fixture-password");
  await waitFor(() => {
    expect(c.getByRole("textbox", { name: "Email" })).toHaveValue(
      "reviewer@example.test",
    );
    expect(c.getByLabelText("Password")).toHaveValue("fixture-password");
    expect(c.getByRole("button", { name: "Sign In" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  });
  await userEvent.click(c.getByRole("button", { name: "Sign In" }));
}
export const SignInFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    await submit(canvasElement);
    await within(canvasElement).findByText(
      "The request failed. Please try again.",
    );
  },
};
export const SigningIn: Story = {
  parameters: { fixtureState: "saving" },
  play: async ({ canvasElement }) => {
    await submit(canvasElement);
    await expect(
      await within(canvasElement).findByRole("button", { name: "Working…" }),
    ).toBeDisabled();
  },
};
export const SignedIn: Story = {
  play: async ({ canvasElement }) => {
    await submit(canvasElement);
    await within(canvasElement).findByRole("button", {
      name: "New Organization",
    });
  },
};
