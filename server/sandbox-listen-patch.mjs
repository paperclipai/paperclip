// Preload patch: force all server.listen() calls to bind to 127.0.0.1
// This works around sandbox restrictions that block 0.0.0.0 binding
import net from "node:net";

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  // listen(port, host, backlog, callback) or listen(options, callback)
  if (args.length >= 2 && typeof args[0] === "number" && typeof args[1] === "string") {
    const host = args[1];
    if (host === "0.0.0.0" || host === "::" || host === "") {
      args[1] = "127.0.0.1";
    }
  }
  return originalListen.apply(this, args);
};
