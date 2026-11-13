import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import {
  OnboardingWizard,
  ONBOARDING_STORAGE_KEY,
} from "@/components/OnboardingWizard";
import { useDialog } from "@/context/DialogContext";
import { useCompanyListQuery } from "@/api/companies-query";
import { Button } from "@/components/ui/button";
import {
  seedOnboardingDraft,
  clearOnboardingDraft,
} from "../../fixtures/onboardingDraft";
function Resume() {
  const companies = useCompanyListQuery();
  const { openOnboarding } = useDialog();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (companies.isSuccess)
      openOnboarding({ initialStep: 3, companyId: "company-storybook" });
  }, [companies.isSuccess, openOnboarding]);
  return (
    <>
      {companies.isSuccess ? <OnboardingWizard key={generation} /> : null}
      <Button
        className="fixed bottom-4 right-4 z-50"
        onClick={() => {
          setGeneration((n) => n + 1);
          openOnboarding({ initialStep: 3, companyId: "company-storybook" });
        }}
      >
        Reopen saved draft
      </Button>
    </>
  );
}
const meta = {
  id: "feature-onboarding-resume",
  title:
    "Getting started and access/Onboarding and first work/Resume a saved draft",
  component: Resume,
  parameters: { layout: "fullscreen",
    paperclip: {
      "capabilities": [
        "onboarding/resume"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "OnboardingWizard restores a seeded draft, malformed/unavailable-company handling and draft retention across a fixture remount. The reopen button belongs to the fixture host; real reload, account switch and storage failure remain separate checks."
    },
  },
  beforeEach: ({ parameters }) => {
    seedOnboardingDraft();
    if (parameters.invalid)
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "invalid JSON");
    if (parameters.otherCompany)
      localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({
          step: 3,
          createdCompanyId: "unavailable-company",
          agentName: "Another account's draft",
        }),
      );
    return clearOnboardingDraft;
  },
} satisfies Meta<typeof Resume>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SavedAgentName: Story = {
  play: async () => {
    await waitFor(
      () =>
        expect(
          within(document.body).getByDisplayValue("Darnold"),
        ).toBeInTheDocument(),
      { timeout: 10000 },
    );
  },
};
export const DraftAfterRemount: Story = {
  play: async ({ canvasElement }) => {
    const body = within(document.body);
    const input = await body.findByDisplayValue(
      "Darnold",
      {},
      { timeout: 10000 },
    );
    await userEvent.clear(input);
    await userEvent.click(input);
    await userEvent.paste("Release reviewer");
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}")
          .agentName,
      ).toBe("Release reviewer"),
    );
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Reopen saved draft" }),
    );
    await body.findByDisplayValue("Release reviewer");
  },
};
export const MalformedDraft: Story = { parameters: { invalid: true } };
export const UnavailableCompanyDraft: Story = {
  parameters: { otherCompany: true },
  play: async () => {
    const body = within(document.body);
    await expect(await body.findByTestId("onboarding-wizard")).toBeVisible();
    const name = await body.findByLabelText("Agent name");
    await waitFor(() => expect(name).toBeVisible(), { timeout: 10000 });
    await expect(name).toHaveValue("");
    await waitFor(() =>
      expect(
        body.queryByDisplayValue("Another account's draft"),
      ).not.toBeInTheDocument(),
    );
  },
};
