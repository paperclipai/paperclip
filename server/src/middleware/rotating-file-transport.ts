import pretty from "pino-pretty";
import { RotatingFileStream } from "./rotating-file-stream.js";

type RotatingFileTransportOptions = {
  logFile: string;
  maxBytes?: number;
  maxArchives?: number;
  translateTime?: string;
  ignore?: string;
  singleLine?: boolean;
  colorize?: boolean;
};

export default async function rotatingFileTransport(options: RotatingFileTransportOptions) {
  const destination = new RotatingFileStream({
    filePath: options.logFile,
    maxBytes: options.maxBytes,
    maxArchives: options.maxArchives,
  });

  return pretty({
    translateTime: options.translateTime,
    ignore: options.ignore,
    singleLine: options.singleLine,
    colorize: options.colorize,
    destination,
  });
}

