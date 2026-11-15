'use strict';
/**
 * FileHelper 插件（本地文件读写）
 * 对应 Windows: plugins/filehelper/filehelper.pln
 *
 * 返回值约定（从页面代码逆推）：
 *   existfileorfolder  -> {"result":true|false}
 *   deletefileordirectory -> {"result":true|false}
 *   getfoledersize     -> {"flag":<字节数>}
 *   readfile           -> 文件文本内容（走 payload.readfile_callback）
 *   readbinaryfile     -> base64
 *   getmd5             -> 32 位小写 md5
 *   aliyun_oss_md5     -> md5 的 base64
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { md5File, ossMd5File } = require('../util');

async function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let items = [];
    try { items = await fsp.readdir(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const it of items) {
      const full = path.join(cur, it.name);
      out.push(full);
      if (it.isDirectory()) stack.push(full);
    }
  }
  return out;
}

async function dirSize(dir) {
  let total = 0;
  for (const f of await walk(dir)) {
    try {
      const st = await fsp.stat(f);
      if (st.isFile()) total += st.size;
    } catch (e) { /* ignore */ }
  }
  return total;
}

module.exports = {
  init(api) { api.respond('0'); },

  readfile(api) {
    const p = api.payload || {};
    const file = api.ctx.resolve(p.filepath);
    const cb = p.readfile_callback;
    fs.readFile(file, 'utf8', (err, text) => {
      if (err) {
        api.log.warn(`[filehelper] readfile 失败 ${file}: ${err.code}`);
        if (cb) api.emit(cb, '');
        api.respond('');
        return;
      }
      if (cb) api.emit(cb, text);
      api.respond('0');
    });
  },

  readbinaryfile(api) {
    const p = api.payload || {};
    const file = api.ctx.resolve(p.filepath);
    fs.readFile(file, (err, buf) => {
      if (err) { api.respond(''); return; }
      api.respond(buf.toString('base64'));
    });
  },

  writefile(api) {
    const p = api.payload || {};
    const file = api.ctx.resolve(p.filepath);
    fsp.mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.writeFile(file, p.content === undefined ? '' : String(p.content), 'utf8'))
      .then(() => api.respond('0'))
      .catch((e) => { api.log.error(`[filehelper] writefile ${file}: ${e.message}`); api.respond(''); });
  },

  writefilewithbinary(api) {
    const p = api.payload || {};
    const file = api.ctx.resolve(p.filepath);
    const content = p.content === undefined ? '' : String(p.content);
    // 页面传的是 base64；若不是合法 base64 则按 latin1 落盘
    let buf;
    try {
      buf = /^[A-Za-z0-9+/=\r\n]+$/.test(content) ? Buffer.from(content, 'base64') : Buffer.from(content, 'binary');
    } catch (e) { buf = Buffer.from(content, 'binary'); }
    fsp.mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.writeFile(file, buf))
      .then(() => api.respond('0'))
      .catch((e) => { api.log.error(`[filehelper] writebinary ${file}: ${e.message}`); api.respond(''); });
  },

  existfileorfolder(api) {
    const p = api.payload || {};
    const target = api.ctx.resolve(p.destPath);
    fs.access(target, fs.constants.F_OK, (err) => api.respond({ result: !err }));
  },

  createfolder(api) {
    const p = api.payload || {};
    const dir = api.ctx.resolve(p.destPath);
    fsp.mkdir(dir, { recursive: true })
      .then(() => api.respond({ result: true }))
      .catch(() => api.respond({ result: false }));
  },

  copyfileordirectory(api) {
    const p = api.payload || {};
    const src = api.ctx.resolve(p.sourceDir);
    const dst = api.ctx.resolve(p.targetDir);
    fsp.mkdir(path.dirname(dst), { recursive: true })
      .then(() => fsp.cp(src, dst, { recursive: true }))
      .then(() => api.respond({ result: true }))
      .catch((e) => { api.log.warn(`[filehelper] copy ${src}->${dst}: ${e.message}`); api.respond({ result: false }); });
  },

  deletefileordirectory(api) {
    const p = api.payload || {};
    const target = api.ctx.resolve(p.filePath);
    // 安全边界：只允许删除应用数据目录内的内容
    if (!api.ctx.isInsideDataRoot(target)) {
      api.log.warn(`[filehelper] 拒绝删除数据目录外的路径: ${target}`);
      api.respond({ result: false });
      return;
    }
    fsp.rm(target, { recursive: true, force: true })
      .then(() => api.respond({ result: true }))
      .catch(() => api.respond({ result: false }));
  },

  removefiletootherpath(api) {
    const p = api.payload || {};
    const from = api.ctx.resolve(p.oldPath);
    const to = api.ctx.resolve(p.newPath);
    fsp.mkdir(path.dirname(to), { recursive: true })
      .then(() => fsp.rename(from, to))
      .then(() => api.respond({ result: true }))
      .catch((e) => { api.log.warn(`[filehelper] move: ${e.message}`); api.respond({ result: false }); });
  },

  renamefolder(api) {
    const p = api.payload || {};
    const from = api.ctx.resolve(p.srcPath);
    const to = api.ctx.resolve(p.destPath);
    fsp.rename(from, to)
      .then(() => api.respond({ result: true }))
      .catch(() => api.respond({ result: false }));
  },

  getfoledersize(api) {
    const p = api.payload || {};
    const dir = api.ctx.resolve(p.dirpath);
    dirSize(dir).then((n) => api.respond({ flag: n })).catch(() => api.respond({ flag: 0 }));
  },

  ergodicfiles(api) {
    const p = api.payload || {};
    const dir = api.ctx.resolve(p.folder);
    walk(dir).then((list) => api.respond(JSON.stringify(list))).catch(() => api.respond('[]'));
  },

  getbase64(api) {
    const p = api.payload || {};
    const file = api.ctx.resolve(p.filepath);
    const cb = p.base64_callback;
    fs.readFile(file, (err, buf) => {
      const val = err ? '' : buf.toString('base64');
      if (err) api.log.warn(`[filehelper] getbase64 失败 ${file}: ${err.code}`);
      if (cb) api.emit(cb, val);
      api.respond(val);
    });
  },

  getmd5(api) {
    const p = api.payload || {};
    md5File(api.ctx.resolve(p.filepath))
      .then((h) => api.respond(h))
      .catch(() => api.respond(''));
  },

  aliyun_oss_md5(api) {
    const p = api.payload || {};
    ossMd5File(api.ctx.resolve(p.filepath))
      .then((h) => api.respond(h))
      .catch(() => api.respond(''));
  },

  /** 页面用来做文件校验，这里用 CRC32 */
  getcode(api) {
    const p = api.payload || {};
    fs.readFile(api.ctx.resolve(p.filepath), (err, buf) => {
      if (err) { api.respond(''); return; }
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
      }
      api.respond(String((crc ^ 0xFFFFFFFF) >>> 0));
    });
  },

  cleardir(api) {
    const p = api.payload || {};
    const dir = api.ctx.resolve(p.dir);
    if (!api.ctx.isInsideDataRoot(dir)) { api.respond({ result: false }); return; }
    fsp.readdir(dir).then((items) => Promise.all(items.map((n) =>
      fsp.rm(path.join(dir, n), { recursive: true, force: true }))))
      .then(() => api.respond({ result: true }))
      .catch(() => api.respond({ result: false }));
  },

  savefiledialog(api) { api.ctx.dialog.save(api.payload || {}).then((r) => api.respond(r)); },
  openfiledialog(api) { api.ctx.dialog.open(api.payload || {}).then((r) => api.respond(r)); },
  openbrowsedialog(api) { api.ctx.dialog.openFolder(api.payload || {}).then((r) => api.respond(r)); },

  closeshell(api) { api.ctx.win.close(); api.respond('0'); },

  /** 加密资源包（RPK/NPK）在 macOS 上未实现，返回空让页面走普通下载分支 */
  readrpk_kqlx(api) {
    const p = api.payload || {};
    api.log.warn('[filehelper] readrpk_kqlx 暂不支持，返回空');
    if (p.big_msg_callback) api.emit(p.big_msg_callback, '');
    api.respond('');
  },
  ncttools(api) { api.respond(''); }
};
