const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 4178;
const DIR = __dirname;

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

http
  .createServer((req, res) => {
    let url = req.url.split("?")[0];
    if (url === "/") url = "/index.html";
    const filePath = path.join(DIR, url);
    const ext = path.extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": mime });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`Dev server → http://127.0.0.1:${PORT}`);
  });
