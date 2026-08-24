#!/usr/bin/env node
// Serves the exported docs folder as a local static site. This is shipped with the export zip from `mint export`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
};

function openInBrowser(url) {
  let command = 'xdg-open';
  switch (process.platform) {
    case 'darwin':
      command = 'open';
      break;
    case 'win32':
      command = 'explorer.exe';
      break;
    default:
      command = 'xdg-open';
  }

  execFile(command, [url], () => undefined);
}

function resolveFile(urlPath) {
  const filePath = path.resolve(DIR, urlPath.replace(/^\/+/, ''));
  if (!filePath.startsWith(DIR + path.sep) && filePath !== DIR) return undefined;
  const candidates = [filePath, path.join(filePath, 'index.html'), filePath + '.html'];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

http
  .createServer((req, res) => {
    let urlPath;
    try {
      const rawPath = (req.url || '/').split('?')[0];
      urlPath = decodeURIComponent(rawPath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const file = resolveFile(urlPath);

    if (file) {
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    }
  })
  .listen(PORT, () => {
    const url = 'http://localhost:' + PORT;
    console.log('Serving docs at ' + url);
    openInBrowser(url);
  });
