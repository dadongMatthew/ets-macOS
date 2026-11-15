'use strict';
/**
 * 通用工具：INI 解析、路径映射、哈希、日志
 * 说明：Windows 客户端里大量路径是 `C:\Users\xxx\AppData\...\common\material\x.mp3`
 *      这类反斜杠路径，这里统一做归一化并映射到 macOS 的应用数据目录。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/** 极简 INI 解析（够用即可，支持 [Section] 与 key = value） */
function parseIni(text) {
  const out = {};
  let section = 'default';
  out[section] = {};
  String(text)
    .split(/\r?\n/)
    .forEach((line) => {
      const s = line.trim();
      if (!s || s.startsWith(';') || s.startsWith('#')) return;
      const m = s.match(/^\[(.+)\]$/);
      if (m) {
        section = m[1].trim();
        out[section] = out[section] || {};
        return;
      }
      const i = s.indexOf('=');
      if (i < 0) return;
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim();
      out[section][k] = v;
    });
  return out;
}

/** 把 INI 的 ShellConfig 段摊平成页面能用的 JSON（键名保持原样，页面按 AppTitle 取值） */
function shellConfigToJson(ini) {
  const cfg = Object.assign({}, ini.ShellConfig || {});
  ['FullScreen', 'ShowTray', 'WindowMaximize', 'NoBorder', 'UseShadow', 'DragZoom', 'CloseApp',
    'AutoUpgrade', 'MultiApp', 'LaunchMode', 'MsgSize', 'LogLevel', 'DisableGPU', 'ForceDeviceScale'
  ].forEach((k) => {
    if (cfg[k] !== undefined && /^-?\d+$/.test(cfg[k])) cfg[k] = Number(cfg[k]);
  });
  cfg.HomeUrl = (ini.HomeUrl && ini.HomeUrl.URL) || '';
  cfg.Platform = 'macos';
  return cfg;
}

/** Windows 路径 -> POSIX 路径（仅做分隔符归一，不做盘符映射） */
function toPosix(p) {
  if (typeof p !== 'string') return p;
  return p.replace(/\\/g, '/');
}

/** 判断是不是 Windows 绝对路径 */
function isWinAbs(p) {
  return /^[a-zA-Z]:[\\/]/.test(p || '');
}

/**
 * 路径映射：把页面传来的任意路径收敛到本机可写目录。
 * - 空 / 相对路径  -> 相对 DATA_ROOT
 * - Windows 绝对路径 -> 取最后两段（如 common/material/x.mp3）挂到 DATA_ROOT 下
 * - 已是 POSIX 绝对路径 -> 原样返回
 */
function resolvePath(p, dataRoot) {
  if (!p) return dataRoot;
  let s = String(p).trim();
  if (isWinAbs(s)) {
    const posix = toPosix(s);
    const idx = posix.toLowerCase().lastIndexOf('/iflytek/');
    const tail = idx >= 0 ? posix.slice(idx + 9) : posix.replace(/^[a-zA-Z]:\//, '');
    return path.join(dataRoot, tail);
  }
  s = toPosix(s);
  if (s.startsWith('/')) return s;
  if (s.startsWith('~')) return path.join(os.homedir(), s.slice(1));
  return path.join(dataRoot, s.replace(/^\.\//, ''));
}

function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    const st = fs.createReadStream(file);
    st.on('data', (d) => h.update(d));
    st.on('end', () => resolve(h.digest('hex')));
    st.on('error', reject);
  });
}

/** 阿里云 OSS 的 Content-MD5：md5 的 base64 */
function ossMd5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    const st = fs.createReadStream(file);
    st.on('data', (d) => h.update(d));
    st.on('end', () => resolve(h.digest('base64')));
    st.on('error', reject);
  });
}

/** 机器唯一标识（优先硬件序列号，失败则退化为 hostname+用户名 的哈希） */
function machineId() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf8', timeout: 4000
    });
    const m = out.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
    if (m && m[1]) return crypto.createHash('md5').update('ets:' + m[1]).digest('hex').toUpperCase();
  } catch (e) { /* ignore */ }
  const seed = `${os.hostname()}|${os.userInfo().username}|${os.arch()}`;
  return crypto.createHash('md5').update('ets:' + seed).digest('hex').toUpperCase();
}

/** 简单文件日志（按天滚动，只保留最近 10 个） */
function createLogger(logDir, name = 'bridge') {
  fs.mkdirSync(logDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(logDir, `${name}-${day}.log`);
  let stream = null;
  try {
    stream = fs.createWriteStream(file, { flags: 'a' });
  } catch (e) { /* ignore */ }
  const write = (level, args) => {
    const line = `[${new Date().toISOString()}] [${level}] ` +
      args.map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(' ');
    if (stream) stream.write(line + '\n');
    if (level === 'ERROR') console.error(line); else console.log(line);
  };
  return {
    file,
    info: (...a) => write('INFO', a),
    warn: (...a) => write('WARN', a),
    error: (...a) => write('ERROR', a)
  };
}

module.exports = {
  parseIni, shellConfigToJson, toPosix, isWinAbs, resolvePath,
  md5File, ossMd5File, machineId, createLogger
};
