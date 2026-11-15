'use strict';
/**
 * CEF 桥接总线（cef.message 的 macOS 实现）
 *
 * 逆向结论：Windows 客户端是 CEF 壳，向页面注入一个名为 cef.message 的 JS 扩展，
 * 页面侧所有原生能力都通过 3 个方法完成：
 *   cef.message.createGuid()                    -> 生成唯一回调 id
 *   cef.message.setMessageCallback(id, fn)      -> 注册回调
 *   cef.message.sendMessage(id, target, func, jsonArgs)  -> 调用原生插件
 * 原生插件处理完，把「字符串」结果回吐给 id 对应的回调（多数是 JSON 字符串）。
 *
 * 本文件只负责收发与分发，具体能力在各 plugins/*.js 里实现。
 */
const crypto = require('crypto');

const PLUGINS = {
  appcontroller: require('./plugins/appcontroller'),
  shellhelper: require('./plugins/shellhelper'),
  filehelper: require('./plugins/filehelper'),
  httphelper: require('./plugins/httphelper'),
  sqlitepln: require('./plugins/sqlitepln'),
  sevenzip: require('./plugins/sevenzip'),
  soundhelper: require('./plugins/soundhelper'),
  etshelper: require('./plugins/etshelper'),
  sysconfig: require('./plugins/sysconfig')
};

function createGuid() {
  return crypto.randomBytes(16).toString('hex');
}

class Bridge {
  constructor(opts) {
    this.homeUrl = opts.homeUrl;
    this.log = opts.log;
    this.ctx = opts.ctx; // 由 preload 提供的宿主能力（ipc 封装、路径解析等）
    this.callbacks = new Map();
    this.stats = { sent: 0, responded: 0, missing: 0, failed: 0 };
    this.verbose = opts.verbose !== false;
  }

  setMessageCallback(id, fn) {
    if (typeof fn !== 'function') return;
    this.callbacks.set(id, fn);
  }

  removeMessageCallback(id) {
    this.callbacks.delete(id);
  }

  /** 向页面回调投递（payload 统一转成字符串，和 CEF 原生行为一致） */
  respond(cbId, payload) {
    if (!cbId) return;
    const cb = this.callbacks.get(cbId);
    if (!cb) {
      this.stats.missing++;
      this.log.warn(`[bridge] 回调已失效: ${cbId}`);
      return;
    }
    let data;
    if (payload === undefined || payload === null) data = '';
    else if (typeof payload === 'string') data = payload;
    else if (typeof payload === 'number' || typeof payload === 'boolean') data = String(payload);
    else {
      try { data = JSON.stringify(payload); } catch (e) { data = ''; }
    }
    this.stats.responded++;
    // 大字符串回传容易把渲染进程撑爆（历史上有 2.8MB zip 转 base64 后崩溃的案例），
    // 超过 1MB 时记一笔，便于定位是哪个回调在传大对象。
    if (data.length > 1024 * 1024) {
      this.log.warn(`[bridge] 大回调 ${cbId} ${Math.round(data.length / 1024)}KB`);
    }
    try {
      cb(data);
    } catch (e) {
      this.log.error(`[bridge] 回调执行异常 ${cbId}: ${e && e.message}`);
    }
  }

  sendMessage(cbId, target, func, args) {
    this.stats.sent++;
    const pluginName = String(target || '').toLowerCase();
    const plugin = PLUGINS[pluginName];
    const payloadText = args === undefined || args === null ? '' : String(args);

    if (this.verbose) {
      this.log.info(`[bridge] -> ${target}.${func} cb=${cbId} args=${payloadText.slice(0, 400)}`);
    }

    if (!plugin) {
      this.log.warn(`[bridge] 未知插件: ${target}.${func}，返回空串`);
      setTimeout(() => this.respond(cbId, ''), 0);
      return;
    }

    let payload;
    if (payloadText === '') payload = undefined;
    else {
      try { payload = JSON.parse(payloadText); } catch (e) { payload = payloadText; }
    }

    const api = {
      respond: (v) => this.respond(cbId, v),
      /** 主动向页面某个 id 投事件（例如录音结束、下载进度） */
      emit: (id, v) => this.respond(id, v),
      payload,
      ctx: this.ctx,
      log: this.log,
      bridge: this
    };

    const handler = plugin[func];
    if (typeof handler !== 'function') {
      this.log.warn(`[bridge] 未实现: ${target}.${func}，返回空串`);
      this.stats.failed++;
      setTimeout(() => this.respond(cbId, ''), 0);
      return;
    }

    // 异步执行，避免阻塞页面渲染（CEF 原生同样是异步回吐）
    Promise.resolve()
      .then(() => handler(api))
      .catch((e) => {
        this.stats.failed++;
        this.log.error(`[bridge] ${target}.${func} 异常: ${e && (e.stack || e.message || e)}`);
        this.respond(cbId, '');
      });
  }

  /** 生成注入页面的 cef 对象 */
  createCefObject() {
    return {
      message: {
        createGuid: () => createGuid(),
        setMessageCallback: (id, fn) => this.setMessageCallback(id, fn),
        removeMessageCallback: (id) => this.removeMessageCallback(id),
        sendMessage: (cbId, target, func, args) => this.sendMessage(cbId, target, func, args),
        getHomeUrl: () => this.homeUrl,
        // 页面用它拼本地资源目录：${EXE_PATH}\packages
        getExePath: () => this.ctx.paths.appRoot,
        // 页面用它读外壳配置（部分老逻辑仍会取 AppTitle / CloseApp 等）
        getAppConfig: () => JSON.stringify(this.ctx.shellConfig || {}),
        getVersion: () => (this.ctx.paths.version || '1.0.0')
      }
    };
  }
}

module.exports = { Bridge, createGuid, PLUGINS };
