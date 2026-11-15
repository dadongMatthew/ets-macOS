'use strict';
/**
 * HttpHelper 插件（原生下载/上传，带进度）
 * 对应 Windows: plugins/httphelper/httphelper.pln
 *
 * 页面约定的回调字段：
 *   download -> JSON {"rncode":0,"rmsg":"ok","filePath":"..."}（rncode=0 表示成功）
 *   upload   -> 服务器返回的字符串（一般是 JSON 文本）
 *   进度     -> httpload_progress_callback_id
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 6 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 6 })
};

function pickClient(u) {
  return u.protocol === 'http:' ? http : https;
}

/** 带重定向 + 进度 + 超时的下载 */
function download(url, dest, opts = {}) {
  const { onProgress, timeout = 60000, connectTimeout = 10000, redirects = 5 } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    let u;
    try { u = new URL(url); } catch (e) { return done(new Error('bad url: ' + url)); }
    const client = pickClient(u);
    const req = client.get(u, { agent: agents[u.protocol], timeout: connectTimeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return download(next, dest, { ...opts, redirects: redirects - 1 }).then(() => done(), done);
      }
      if (res.statusCode >= 400) {
        res.resume();
        return done(new Error('http ' + res.statusCode));
      }
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      fsp.mkdir(path.dirname(dest), { recursive: true }).then(() => {
        const ws = fs.createWriteStream(dest);
        const overall = setTimeout(() => { req.destroy(); done(new Error('timeout')); }, timeout);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });
        res.pipe(ws);
        ws.on('finish', () => { clearTimeout(overall); ws.close(() => done()); });
        ws.on('error', (e) => { clearTimeout(overall); done(e); });
        res.on('error', (e) => { clearTimeout(overall); done(e); });
      }).catch(done);
    });
    req.on('timeout', () => { req.destroy(); done(new Error('connect timeout')); });
    req.on('error', (e) => done(e));
  });
}

/** 组装 multipart/form-data */
function partContentType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.xml') return 'application/xml';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
}

function buildMultipart(fields, fileField, filePath, fileBuf) {
  const boundary = '----ETSFormBoundary' + Math.random().toString(16).slice(2);
  const chunks = [];
  const push = (s) => chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));
  Object.keys(fields || {}).forEach((k) => {
    const v = fields[k];
    if (v === undefined || v === null) return;
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`);
  });
  if (filePath) {
    const name = path.basename(filePath);
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${name}"\r\n`);
    push(`Content-Type: ${partContentType(name)}\r\n\r\n`);
    push(fileBuf || fs.readFileSync(filePath));
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

module.exports = {
  init(api) { api.respond('0'); },

  download(api) {
    const p = api.payload || {};
    const dest = api.ctx.resolve(p.localFile || p.filePath || p.savePath);
    api.log.info(`[httphelper] download ${p.url} -> ${dest}`);
    download(p.url, dest, {
      timeout: Number(p.timeout || 600) * 1000,
      connectTimeout: Number(p.connecttimeout || 10) * 1000,
      onProgress: (recv, total) => api.ctx.httpProgress(api.payload, recv, total)
    })
      .then(() => api.respond({ rncode: 0, rmsg: 'ok', filePath: dest }))
      .catch((e) => {
        api.log.warn(`[httphelper] download 失败 ${p.url}: ${e.message}`);
        api.respond({ rncode: -1, rmsg: e.message, filePath: dest });
      });
  },

  downloadresource(api) {
    const p = api.payload || {};
    const dest = api.ctx.resolve((p.prefix || '') + (p.suffix || ''));
    download(p.url, dest, {
      timeout: Number(p.timeout || 600) * 1000,
      connectTimeout: Number(p.connecttimeout || 10) * 1000,
      onProgress: (recv, total) => api.ctx.httpProgress(api.payload, recv, total)
    })
      .then(() => api.respond({ rncode: 0, rmsg: 'ok', filePath: dest }))
      .catch((e) => api.respond({ rncode: -1, rmsg: e.message, filePath: dest }));
  },

  downloadsdk(api) {
    const p = api.payload || {};
    const dest = api.ctx.resolve(p.filePath);
    download(p.url, dest, {
      timeout: Number(p.timeout || 600) * 1000,
      connectTimeout: Number(p.connecttimeout || 10) * 1000
    })
      .then(() => api.respond({ rncode: 0, rmsg: 'ok', filePath: dest }))
      .catch((e) => api.respond({ rncode: -1, rmsg: e.message, filePath: dest }));
  },

  /**
   * OSS 直传。页面（`${prefix}${bucket}.${endpoint}` 那段）传的是**扁平**对象：
   *   { OSSAccessKeyId, policy, signature, "x-oss-security-token",
   *     "x-oss-object-acl", key, localFile, url, submit, success_action_status }
   * 除控制字段外，其余全部要原样当成表单字段（少一个 policy/signature OSS 就回 400），
   * 文件字段名固定 file。
   * 返回值按原生插件约定：成功 {"rncode":0}，失败 {"rncode":-1,...}，
   * 页面读 `JSON.parse(y).rncode === 0` 判断成功（之前回的是 OSS 的空 body，必然判失败）。
   */
  upload(api) {
    const p = api.payload || {};
    const url = p.url || p.uploadUrl || p.action;
    const fail = (msg, extra) => {
      api.log.warn(`[httphelper] upload 失败: ${msg}`);
      api.respond(Object.assign({ rncode: -1, rmsg: msg }, extra || {}));
    };
    if (!url) { fail('no url'); return; }

    // 兼容旧式 { data / fields / params } 写法
    const nested = p.data || p.fields || p.params;
    const CONTROL = ['url', 'uploadUrl', 'action', 'localFile', 'filePath', 'file', 'path',
      'name', 'fileKey', 'headers', 'data', 'fields', 'params'];
    const fields = {};
    Object.keys(p).forEach((k) => {
      if (CONTROL.indexOf(k) === -1) fields[k] = p[k];
    });
    if (nested && typeof nested === 'object') Object.assign(fields, nested);

    const fileParam = p.localFile || p.filePath || p.file || p.path;
    if (!fileParam) { fail('no file'); return; }
    const file = api.ctx.resolve(fileParam);
    let fileBuf;
    try { fileBuf = fs.readFileSync(file); } catch (e) { fail(`文件不存在 ${file}`); return; }

    let u;
    try { u = new URL(url); } catch (e) { fail(`bad url ${url}`); return; }

    const { body, contentType } = buildMultipart(fields, p.name || p.fileKey || 'file', file, fileBuf);
    api.log.info(`[httphelper] upload ${file} (${fileBuf.length}B) -> ${u.host}${u.pathname} 字段=${Object.keys(fields).join(',')}`);

    const req = pickClient(u).request(u, {
      method: 'POST',
      agent: agents[u.protocol],
      headers: Object.assign({
        'Content-Type': contentType,
        'Content-Length': body.length
      }, p.headers || {})
    }, (res) => {
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => {
        const text = Buffer.concat(bufs).toString('utf8');
        api.log.info(`[httphelper] upload -> ${res.statusCode} ${text.slice(0, 200)}`);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          api.respond({ rncode: 0, rmsg: 'ok' });
        } else {
          fail(`http ${res.statusCode}`, { status: res.statusCode, body: text.slice(0, 500) });
        }
      });
    });
    req.on('error', (e) => fail(e.message));
    req.end(body);
  },

  isrpkexist(api) { api.respond({ exist: false, result: false }); },
  monitornetspeed(api) { api.respond('0'); },
  stopdownload(api) { api.respond('0'); }
};
