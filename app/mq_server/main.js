'use strict';
/**
 * 本地消息服务（对应 Windows 的 ets_mq_server.exe）
 *
 * 逆向出来的作用：网页启动时会连 ws://127.0.0.1:40001，
 * 用于多窗口/悬浮球之间的消息广播。启动流程里是硬依赖：
 *   1. 检查 ${EXE_PATH}/mq_server/ets_mq_server 是否存在
 *   2. 问 ShellHelper.processexist 有没有在跑
 *   3. 连不上就 reject，整个初始化卡死 → 登录页空白
 *
 * 这里用纯 Node 实现一个「收到什么就广播给所有客户端」的极简 WS 服务，不依赖 ws 包。
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const state = { server: null, port: 0, clients: new Set(), running: false };

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** 组一个服务端 -> 客户端的文本帧（不掩码） */
function encodeFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 解析客户端帧（客户端必须掩码） */
function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const fin = (buf[offset] & 0x80) !== 0;
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let len = buf[offset + 1] & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      mask = buf.slice(p, p + 4);
      p += 4;
    }
    if (p + len > buf.length) break;
    const payload = Buffer.from(buf.slice(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ fin, opcode, payload });
    offset = p + len;
  }
  return { frames, rest: buf.slice(offset) };
}

function broadcast(text, except) {
  const frame = encodeFrame(text);
  for (const socket of state.clients) {
    if (socket === except || socket.destroyed) continue;
    try { socket.write(frame); } catch (e) { /* ignore */ }
  }
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);
  state.clients.add(socket);
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { frames, rest } = decodeFrames(buffer);
    buffer = rest;
    for (const f of frames) {
      if (f.opcode === 0x8) { try { socket.end(); } catch (e) { /* ignore */ } return; }
      if (f.opcode === 0x9) { try { socket.write(encodeFrame('', 0xA)); } catch (e) { /* ignore */ } continue; }
      if (f.opcode === 0x1 || f.opcode === 0x2) {
        // 原始实现就是「收到即广播给所有连接」
        broadcast(f.payload.toString('utf8'), socket);
      }
    }
  });
  const drop = () => state.clients.delete(socket);
  socket.on('close', drop);
  socket.on('error', drop);
}

/** 端口被占用就往后找，和原版行为一致（40001 起） */
function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ets mq server');
    });
    server.on('upgrade', handleUpgrade);
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && port < 40100) resolve(listen(port + 1));
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      state.server = server;
      state.port = port;
      state.running = true;
      resolve(port);
    });
  });
}

/** 把端口写进 packages/app.json，页面会通过 cef.message.getAppConfig() 读取 */
function writePortConfig(exePath, port) {
  try {
    const file = path.join(exePath, 'packages', 'app.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let cfg = {};
    if (fs.existsSync(file)) {
      try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { cfg = {}; }
    }
    cfg.suspensionBallPort = port;
    fs.writeFileSync(file, JSON.stringify(cfg));
  } catch (e) { /* ignore */ }
}

async function start(exePath) {
  if (state.running) return state.port;
  const port = await listen(40001);
  if (exePath) writePortConfig(exePath, port);
  return port;
}

function isRunning() { return state.running; }
function getPort() { return state.port; }

function stop() {
  for (const s of state.clients) { try { s.destroy(); } catch (e) { /* ignore */ } }
  state.clients.clear();
  if (state.server) state.server.close();
  state.running = false;
}

module.exports = { start, stop, isRunning, getPort, broadcast };

// 允许独立运行（对应原来的 ets_mq_server.exe）
if (require.main === module) {
  start(process.argv[2] || path.join(__dirname, '..'))
    .then((p) => console.log('mq server listening on', p))
    .catch((e) => { console.error('mq server failed:', e.message); process.exit(1); });
}
