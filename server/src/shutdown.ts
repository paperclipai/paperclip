type HotRestartShutdownPreparation = {
  skipDrain: boolean;
};

export async function coordinateHeartbeatSchedulerShutdown<
  TPreparation extends HotRestartShutdownPreparation,
>(input: {
  signal: "SIGINT" | "SIGTERM";
  prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<TPreparation>) | null;
  waitForHeartbeatSchedulerIdle: () => Promise<void>;
}): Promise<{
  hotRestart: TPreparation | null;
  preparationError: unknown;
  waitedForSchedulerIdle: boolean;
}> {
  let hotRestart: TPreparation | null = null;
  let preparationError: unknown = null;

  if (input.prepareHotRestartShutdown) {
    try {
      hotRestart = await input.prepareHotRestartShutdown(input.signal);
    } catch (err) {
      preparationError = err;
    }
  }

  if (hotRestart?.skipDrain) {
    return {
      hotRestart,
      preparationError,
      waitedForSchedulerIdle: false,
    };
  }

  await input.waitForHeartbeatSchedulerIdle();
  return {
    hotRestart,
    preparationError,
    waitedForSchedulerIdle: true,
  };
}
