#!/usr/bin/env node
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.STUDIO_PORT || 14600);
const BIND = process.env.STUDIO_BIND || '127.0.0.1';
const DAEMON_HOST = process.env.GOXLR_HOST || '127.0.0.1';
const DAEMON_PORT = Number(process.env.GOXLR_PORT || 14564);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.STUDIO_DATA || path.join(__dirname, 'data');
const EQ_FILE = path.join(DATA_DIR, 'output-eq.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function daemonHeaders(headers) {
  const out = { ...headers, host: `${DAEMON_HOST}:${DAEMON_PORT}` };
  // The daemon's CORS filter only accepts localhost origins; the proxy is same-origin for the browser.
  delete out.origin;
  delete out.referer;
  return out;
}

function proxyHttp(req, res) {
  const upstream = http.request(
    { host: DAEMON_HOST, port: DAEMON_PORT, method: req.method, path: req.url, headers: daemonHeaders(req.headers) },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Error: 'GoXLR daemon unreachable' }));
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  const upstream = net.connect(DAEMON_PORT, DAEMON_HOST, () => {
    const headers = daemonHeaders(req.headers);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
    upstream.write(raw + '\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => { socket.destroy(); upstream.destroy(); };
  upstream.on('error', close);
  socket.on('error', close);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleStudioApi(req, res) {
  if (req.url === '/studio/output-eq') {
    if (req.method === 'GET') {
      fs.readFile(EQ_FILE, 'utf8', (err, txt) => {
        res.writeHead(200, { 'content-type': MIME['.json'] });
        res.end(err ? 'null' : txt);
      });
      return;
    }
    if (req.method === 'PUT') {
      try {
        const body = await readBody(req);
        JSON.parse(body);
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = EQ_FILE + '.tmp';
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, EQ_FILE);
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end(String(e.message || e));
      }
      return;
    }
  }
  if (req.url === '/studio/info') {
    res.writeHead(200, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify({ daemon: `${DAEMON_HOST}:${DAEMON_PORT}`, version: require('./package.json').version }));
    return;
  }
  res.writeHead(404).end();
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxyHttp(req, res);
  if (req.url.startsWith('/studio/')) return handleStudioApi(req, res);
  serveStatic(req, res);
});
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/api/websocket')) proxyUpgrade(req, socket, head);
  else socket.destroy();
});
server.listen(PORT, BIND, () => {
  console.log(`GoXLR Studio: http://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PORT}/  (daemon ${DAEMON_HOST}:${DAEMON_PORT})`);
});
