import http from "node:http";
import https from "node:https";

// Node.js 19+ enables keepAlive on globalAgent by default, and HTTP servers
// default to keepAliveTimeout=5000ms. Both cause supertest requests to reuse
// connections across test servers: if the OS recycles the same ephemeral port
// for a new server while the old server's keepAlive connection is still open,
// the next request routes to the wrong server and gets a bogus 200 {}.
//
// Fix: disable keepAlive on both the HTTP client and all test servers, and
// call closeAllConnections() before server.close() so sockets are destroyed
// immediately rather than waiting for keepAlive timeout to expire.

http.globalAgent.destroy();
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent.destroy();
https.globalAgent = new https.Agent({ keepAlive: false });

// Force all test servers to destroy connections immediately on close
const originalClose = http.Server.prototype.close;
http.Server.prototype.close = function (callback?: (err?: Error) => void) {
  if (typeof this.closeAllConnections === "function") {
    this.closeAllConnections();
  }
  return originalClose.call(this, callback);
};

const originalCreateServer = http.createServer.bind(http);
(http as any).createServer = function (...args: Parameters<typeof http.createServer>) {
  const server = originalCreateServer(...args);
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  return server;
};
