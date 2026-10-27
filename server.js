/* Мини-сервер без зависимостей: раздаёт файлы игры по HTTP и держит
   комнаты для игры по локальной сети (WebSocket на /ws).
   Запуск:  node server.js   (порт по умолчанию 8000, можно задать PORT=9000)
   Нужен, чтобы играть по сети и чтобы браузер не ругался на file://. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  // защита от выхода за пределы папки игры
  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — файл не найден');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

/* ---------------------- WebSocket-комнаты (локальная сеть) ---------------------- */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_FRAME = 4 * 1024 * 1024;

const rooms = new Map(); // код -> { host, guest }
const clients = new Set();

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

function rawSend(conn, opcode, payload) {
  if (conn.closed || !conn.socket.writable) return;
  try { conn.socket.write(frame(opcode, payload)); } catch { /* сокет уже закрыт */ }
}

function send(conn, obj) {
  rawSend(conn, 0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function readFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_FRAME)) return null;
    len = Number(big);
    off = 10;
  }
  if (len > MAX_FRAME) return null;

  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;

  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  return { opcode, payload, size: off + len };
}

function dropConn(conn) {
  if (conn.closed) return;
  conn.closed = true;
  clients.delete(conn);

  const code = conn.room;
  conn.room = null;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  if (conn.role === 'host') {
    rooms.delete(code);
    const guest = room.guest;
    if (guest && !guest.closed) {
      guest.room = null;
      guest.role = null;
      send(guest, { t: 'peer-gone' });
    }
  } else {
    room.guest = null;
    const host = room.host;
    if (host && !host.closed) send(host, { t: 'peer-gone' });
  }
}

function handleText(conn, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.t === 'host') {
    if (conn.room) return;
    const code = makeCode();
    rooms.set(code, { host: conn, guest: null });
    conn.room = code;
    conn.role = 'host';
    send(conn, { t: 'code', code });
    return;
  }

  if (msg.t === 'join') {
    if (conn.room) return;
    const code = String(msg.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room || !room.host || room.host.closed) {
      send(conn, { t: 'nope' });
      return;
    }
    if (room.guest && !room.guest.closed) {
      send(conn, { t: 'full' });
      return;
    }
    room.guest = conn;
    conn.room = code;
    conn.role = 'guest';
    send(conn, { t: 'joined', code });
    send(room.host, { t: 'peer' });
    send(conn, { t: 'peer' });
    return;
  }

  const room = conn.room ? rooms.get(conn.room) : null;
  if (!room) return;
  const other = conn.role === 'host' ? room.guest : room.host;
  if (other && !other.closed) rawSend(other, 0x1, Buffer.from(text, 'utf8'));
}

server.on('upgrade', (req, socket) => {
  socket.on('error', () => { /* обрабатываем ниже */ });

  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (!key || upgrade !== 'websocket') {
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const conn = { socket, buf: Buffer.alloc(0), room: null, role: null, closed: false };
  clients.add(conn);

  socket.on('data', (chunk) => {
    conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;
    while (!conn.closed) {
      const parsed = readFrame(conn.buf);
      if (!parsed) break;
      conn.buf = conn.buf.subarray(parsed.size);

      if (parsed.opcode === 0x1) {
        handleText(conn, parsed.payload.toString('utf8'));
      } else if (parsed.opcode === 0x8) {
        dropConn(conn);
        try { socket.end(); } catch { /* noop */ }
        break;
      } else if (parsed.opcode === 0x9) {
        rawSend(conn, 0xa, parsed.payload);
      }
    }
  });

  socket.on('close', () => dropConn(conn));
  socket.on('end', () => dropConn(conn));
  socket.on('error', () => dropConn(conn));
});

// поддерживаем соединения живыми (некоторые сети рвут простаивающие сокеты)
setInterval(() => {
  for (const conn of clients) {
    if (!conn.closed) rawSend(conn, 0x9, Buffer.alloc(0));
  }
}, 25000).unref();

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  Object.values(nets).forEach((list) => {
    (list || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    });
  });

  console.log('');
  console.log('  ♞  Шахматы запущены');
  console.log('     На этом компьютере:  http://localhost:' + PORT);
  ips.forEach((ip) => {
    console.log('     В локальной сети:    http://' + ip + ':' + PORT);
  });
  console.log('');
  console.log('  Не закрывайте это окно, пока играете. Ctrl+C — остановить.');
  console.log('');
});
