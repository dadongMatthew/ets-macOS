'use strict';
/**
 * SevenZip 插件（压缩/解压）
 * 对应 Windows: plugins/sevenzip/sevenzip.pln
 *
 * 实现：优先用随包的 7zz（支持 zip/7z/rar），失败再退回系统 ditto / unzip。
 * 成功回调必须是字符串 "0"（页面判断 e === "0"）。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

function tryExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}

async function unzipWith(zipFile, destPath, password) {
  const sevenZip = path.join(__dirname, '../../../resources/7zz');
  if (fs.existsSync(sevenZip)) {
    const args = ['x', zipFile, `-o${destPath}`, '-y'];
    if (password) args.push(`-p${password}`);
    const r = await tryExec(sevenZip, args);
    if (r.ok) return { ok: true };
    // 7zz 架构不匹配（例如 Intel Mac 上是 arm64 二进制）时继续尝试系统工具
  }
  // ditto 支持 zip（含密码会失败，但不影响无密码包）
  const d = await tryExec('/usr/bin/ditto', ['-x', '-k', zipFile, destPath]);
  if (d.ok) return { ok: true };
  const u = await tryExec('/usr/bin/unzip', ['-o', '-q', zipFile, '-d', destPath]);
  return { ok: u.ok, err: u.err || d.err };
}

module.exports = {
  init(api) { api.respond('0'); },

  unzip(api) {
    const p = api.payload || {};
    const zipFile = api.ctx.resolve(p.zipFile || p.zipFilePath);
    const destPath = api.ctx.resolve(p.destPath || p.destDir);
    fsp.mkdir(destPath, { recursive: true })
      .then(() => unzipWith(zipFile, destPath, p.passWord || p.password))
      .then((r) => {
        if (r.ok) { api.respond('0'); return; }
        api.log.warn(`[sevenzip] unzip 失败 ${zipFile}: ${r.err}`);
        api.respond(r.err || 'unzip failed');
      })
      .catch((e) => api.respond(e.message));
  },

  zip(api) {
    const p = api.payload || {};
    const zipFile = api.ctx.resolve(p.zipFile || p.zipFilePath);
    const list = (p.filePaths || []).map((x) => api.ctx.resolve(x));
    const sevenZip = path.join(__dirname, '../../../resources/7zz');
    const cmd = fs.existsSync(sevenZip) ? sevenZip : '/usr/bin/zip';
    const args = fs.existsSync(sevenZip)
      ? ['a', '-tzip', zipFile, ...list]
      : ['-r', zipFile, ...list];
    tryExec(cmd, args).then((r) => api.respond(r.ok ? '0' : (r.err || 'zip failed')));
  },

  test(api) {
    const p = api.payload || {};
    const zipFile = api.ctx.resolve(p.zipFile || p.zipFilePath);
    const sevenZip = path.join(__dirname, '../../../resources/7zz');
    if (!fs.existsSync(sevenZip)) { api.respond('0'); return; }
    tryExec(sevenZip, ['t', zipFile]).then((r) => api.respond(r.ok ? '0' : r.err));
  }
};
