'use strict';
/**
 * SqlitePln 插件（本地 SQLite）
 * 对应 Windows: plugins/sqlitepln/sqlitepln.pln
 *
 * 页面只用来读 localdata/ETS.db 的 Config 表（客户端配置：EnvType、C_Version…）。
 * macOS 上直接调用系统自带的 /usr/bin/sqlite3，避免引入需要编译的原生模块。
 *
 * 注意：返回格式必须是 data = JSON.stringify(rows)，rows 是「对象数组」。
 * 页面（clientDB.js）解析方式是：
 *     const r = JSON.parse(结果); const i = JSON.parse(r.data); i[0].Value
 * 即要求每行是带 Entry/Value 字段的对象。早先这里返回的是
 * rows.map(r => JSON.stringify(r))（字符串数组），导致 clientConfig 恒为 {}，
 * 进而 C_Version 为空、EnvType 判断失败触发一次多余的页面 reload。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SQLITE = '/usr/bin/sqlite3';

function run(db, args, sql) {
  return new Promise((resolve, reject) => {
    const child = execFile(SQLITE, [db, ...args], { timeout: 15000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim()));
        else resolve(String(stdout));
      });
    if (sql !== undefined) {
      child.stdin.write(sql);
      child.stdin.end();
    }
  });
}

/** 当前连接的数据库（页面一次只连一个） */
let currentDb = null;

module.exports = {
  init(api) { api.respond('0'); },

  connect(api) {
    const p = api.payload || {};
    const db = api.ctx.resolve(p.dbpath || './localdata/ETS.db');
    try {
      fs.mkdirSync(path.dirname(db), { recursive: true });
      if (!fs.existsSync(db)) {
        // 首次运行：用随包附带的空库模板初始化
        const tpl = path.join(api.ctx.paths.resources, 'ETS.db');
        if (fs.existsSync(tpl)) fs.copyFileSync(tpl, db);
      }
      currentDb = db;
      api.log.info(`[sqlitepln] connect ${db}`);
      api.respond('0');
    } catch (e) {
      api.log.error(`[sqlitepln] connect 失败: ${e.message}`);
      api.respond(JSON.stringify({ code: -1, msg: e.message }));
    }
  },

  execQuery(api) {
    const p = api.payload || {};
    const cb = p.query_result_callback;
    const db = currentDb;
    if (!db) {
      if (cb) api.emit(cb, JSON.stringify({ code: -1, msg: 'not connected', data: '[]' }));
      api.respond('');
      return;
    }
    run(db, ['-json', '-readonly'], String(p.sql || '') + ';')
      .then((out) => {
        let rows = [];
        try { rows = JSON.parse(out || '[]'); } catch (e) { rows = []; }
        if (!Array.isArray(rows)) rows = [];
        // 每行保持对象形态：页面按 row.Entry / row.Value 取值
        const payload = JSON.stringify({ code: 0, msg: 'ok', data: JSON.stringify(rows) });
        if (cb) api.emit(cb, payload);
        api.respond(payload);
      })
      .catch((e) => {
        api.log.warn(`[sqlitepln] query 失败: ${e.message}`);
        const payload = JSON.stringify({ code: -1, msg: e.message, data: '[]' });
        if (cb) api.emit(cb, payload);
        api.respond(payload);
      });
  },

  execDML(api) {
    const p = api.payload || {};
    const db = currentDb;
    if (!db) { api.respond(JSON.stringify({ code: -1, msg: 'not connected' })); return; }
    run(db, [], String(p.sql || ''))
      .then((out) => api.respond(JSON.stringify({ code: 0, msg: 'ok', data: out.trim() })))
      .catch((e) => api.respond(JSON.stringify({ code: -1, msg: e.message })));
  },

  disconnect(api) { currentDb = null; api.respond('0'); },
  destroy(api) { currentDb = null; api.respond('0'); }
};
