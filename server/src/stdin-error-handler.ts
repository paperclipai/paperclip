type StdinError = NodeJS.ErrnoException & { syscall?: string | undefined };

type StdinLike = {
  on(event: "error", listener: (error: StdinError) => void): unknown;
  off?(event: "error", listener: (error: StdinError) => void): unknown;
  removeListener?(event: "error", listener: (error: StdinError) => void): unknown;
};

type InstallStdinErrorHandlerOptions = {
  label: string;
  log?: (message: string) => void;
};

function isTerminalTeardownError(error: StdinError) {
  return error.code === "EIO" && error.syscall === "read";
}

export function installStdinErrorHandler(
  stdinStream: StdinLike,
  options: InstallStdinErrorHandlerOptions,
) {
  const log = options.log ?? ((message: string) => {
    process.stderr.write(`${message}\n`);
  });

  const onError = (error: StdinError) => {
    if (isTerminalTeardownError(error)) {
      return;
    }

    log(`[paperclip] ${options.label} stdin error ignored: ${error.message}`);
  };

  stdinStream.on("error", onError);

  return () => {
    if (typeof stdinStream.off === "function") {
      stdinStream.off("error", onError);
      return;
    }
    stdinStream.removeListener?.("error", onError);
  };
}
