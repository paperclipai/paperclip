import { addons } from "storybook/preview-api";

/** Allows the browser suite to await and inspect Storybook interaction results. */
export const voiceStoryLifecycle = {
  beforeEach() {
    delete document.body.dataset.spekoStoryReady;
    delete document.body.dataset.spekoStoryError;
    const channel = addons.getChannel();
    const report = (error: unknown) => { document.body.dataset.spekoStoryError = JSON.stringify(error); };
    channel.on("playFunctionThrewException", report);
    channel.on("unhandledErrorsWhilePlaying", report);
    return () => {
      channel.off("playFunctionThrewException", report);
      channel.off("unhandledErrorsWhilePlaying", report);
    };
  },
  afterEach({ id }: { id: string }) { document.body.dataset.spekoStoryReady = id; },
};
