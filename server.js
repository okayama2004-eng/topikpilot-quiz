// Zero-dependency static server for the TOPIKPILOT quiz app.
// /tiktok/* is handled by tiktok.js (KaikaLab Content Publisher tool).
const http = require('http');
const fs = require('fs');
const path = require('path');
const tiktok = require('./tiktok');

const port = process.env.PORT || 3000;
const root = __dirname;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/tiktok' || urlPath.startsWith('/tiktok/')) {
    tiktok.handle(req, res).catch(() => { try { res.writeHead(500); res.end('Error'); } catch (e) {} });
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(root, urlPath);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, () => console.log('Listening on ' + port));
