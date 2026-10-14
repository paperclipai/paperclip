import { addons } from "storybook/preview-api";
import { userEvent, within } from "storybook/test";

export const reviewLifecycle = {
  beforeEach: () => {
    delete document.body.dataset.providerRoutingReady;
    delete document.body.dataset.providerRoutingError;
    const channel = addons.getChannel();
    const report = (error: unknown) => {
      document.body.dataset.providerRoutingError = JSON.stringify(error);
    };
    channel.on("playFunctionThrewException", report);
    channel.on("unhandledErrorsWhilePlaying", report);
    return () => {
      channel.off("playFunctionThrewException", report);
      channel.off("unhandledErrorsWhilePlaying", report);
    };
  },
  afterEach: ({ id }: { id: string }) => {
    document.body.dataset.providerRoutingReady = id;
  },
};
export async function choose(
  canvasElement: HTMLElement,
  label: string,
  option: string,
) {
  await userEvent.click(
    within(canvasElement).getByRole("combobox", { name: label }),
  );
  await userEvent.click(
    await within(canvasElement.ownerDocument.body).findByRole("option", {
      name: option,
    }),
  );
}
