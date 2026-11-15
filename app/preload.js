'use strict';
/**
 * preload：把 CEF 壳的 JS 扩展 cef.message 注入页面，并实现所有插件的 macOS 版本。
 *
 * 关键点：contextIsolation 必须为 false —— 页面自己的 plugins/stic/*.js 直接引用全局
 * `cef`，只有同世界注入才能被它看到（这与 Windows 上 CEF 注入扩展的时机一致）。
 */
const { ipcRenderer } = require('electron');
const { Bridge } = require('./bridge/bus');
const util = require('./bridge/util');

const boot = ipcRenderer.sendSync('bootstrap:config');
const log = {
  info: (...a) => { ipcRenderer.send('log:write', 'INFO', a.map(fmt)); },
  warn: (...a) => { ipcRenderer.send('log:write', 'WARN', a.map(fmt)); },
  error: (...a) => { ipcRenderer.send('log:write', 'ERROR', a.map(fmt)); },
  file: boot.logFile
};
function fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

/** 主进程能力的薄封装 */
const ctx = {
  paths: boot.paths,
  shellConfig: boot.shellConfig,
  win: {
    close: () => ipcRenderer.invoke('win:action', 'close'),
    maximize: () => ipcRenderer.invoke('win:action', 'maximize'),
    minimize: () => ipcRenderer.invoke('win:action', 'minimize'),
    restore: () => ipcRenderer.invoke('win:action', 'restore'),
    fullscreen: (on) => ipcRenderer.invoke('win:action', on ? 'fullscreen' : 'reduction'),
    hide: () => ipcRenderer.invoke('win:action', 'hide'),
    show: () => ipcRenderer.invoke('win:action', 'show'),
    getPos: () => ipcRenderer.invoke('win:getPos'),
    setPos: (p) => ipcRenderer.invoke('win:setPos', p),
    drag: (start, end) => ipcRenderer.invoke('win:drag', { start, end })
  },
  dialog: {
    save: (p) => ipcRenderer.invoke('dialog:save', p),
    open: (p) => ipcRenderer.invoke('dialog:open', p),
    openFolder: (p) => ipcRenderer.invoke('dialog:openFolder', p)
  },
  clipboard: {
    saveImageTo: (p) => ipcRenderer.invoke('clipboard:saveImage', p)
  },
  volume: {
    get: () => ipcRenderer.invoke('volume:get'),
    set: (v) => ipcRenderer.invoke('volume:set', v),
    getMute: () => ipcRenderer.invoke('volume:getMute'),
    setMute: (m) => ipcRenderer.invoke('volume:setMute', m)
  },
  exec: {
    runGuarded: (cmd, opts) => ipcRenderer.invoke('exec:run', cmd, opts),
    kill: (name) => ipcRenderer.invoke('exec:kill', name),
    exists: (name) => ipcRenderer.invoke('exec:exists', name)
  },
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  resolve: (p) => util.resolvePath(p, boot.paths.dataRoot),
  isInsideDataRoot: (p) => {
    const abs = require('path').resolve(p || '');
    return abs === boot.paths.dataRoot || abs.startsWith(boot.paths.dataRoot + require('path').sep);
  },
  /** 下载/上传进度：把进度投给页面注册过的进度回调 */
  httpProgress: (payload, recv, total) => {
    const ids = progressIds;
    if (!ids.length) return;
    const percent = total ? Math.round((recv / total) * 100) : 0;
    const data = { url: (payload && payload.url) || '', percent, received: recv, total };
    ids.forEach((id) => bridge.respond(id, data));
  }
};

/** HttpHelper.init 时记录的进度回调 id 列表 */
const progressIds = [];

const bridge = new Bridge({
  homeUrl: boot.homeUrl,
  log,
  ctx,
  verbose: boot.verbose
});

// 把 HttpHelper 的进度回调登记下来
const rawSet = bridge.setMessageCallback.bind(bridge);
bridge.setMessageCallback = (id, fn) => {
  rawSet(id, fn);
};

// ---------- Uint8Array.fromBase64 垫片（关键） ----------
// 页面的 base64 解码器在模块初始化时就做了能力探测：
//
//   _toUint8Array = typeof Uint8Array.fromBase64 === 'function'
//     ? s => Uint8Array.fromBase64(s)
//     : s => _U8Afrom(_atob(s).split('').map(c => c.charCodeAt(0)))
//
// Electron 31 内置 Chromium 126，没有 fromBase64（该 API 到 Chrome 133 才落地），
// 于是页面必然走回退分支。登录后要解压 2.9MB 的 common.zip（base64 后 3.78MB），
// 回退分支会先 split('') 出 378 万个单字符、再 map 出 378 万元素数组，
// 渲染进程直接 FATAL（node::Buffer::New → node::OnFatalError → SIGBUS），
// 表现就是「登录成功但整页空白」。
//
// 这里按规范补一个原生实现，让页面探测到后走快路径（Buffer 一次性解码 + 一次拷贝）。
// 必须放在页面脚本执行之前 —— preload 天然满足这个时机。
if (typeof Uint8Array.fromBase64 !== 'function') {
  const { Buffer: NodeBuffer } = require('buffer');
  Object.defineProperty(Uint8Array, 'fromBase64', {
    value: function fromBase64(input, options) {
      let s = String(input);
      const alphabet = options && options.alphabet;
      if (alphabet === 'base64url') s = s.replace(/-/g, '+').replace(/_/g, '/');
      // 去掉空白与非法字符，补齐 padding
      s = s.replace(/[^A-Za-z0-9+/=]/g, '');
      const rest = s.length % 4;
      if (rest === 2) s += '==';
      else if (rest === 3) s += '=';
      else if (rest === 1) s = s.slice(0, -1);
      const buf = NodeBuffer.from(s, 'base64');
      const out = new Uint8Array(buf.length);
      out.set(buf);
      return out;
    },
    writable: true,
    enumerable: false,
    configurable: true
  });
  log.info('[shim] 已补 Uint8Array.fromBase64（避免页面走 split/map 大数组回退路径）');
}

// 页面会按 navigator.platform 判定客户端平台（Windows / Linux / Mac OS），
// 某些分支只有 Windows 才渲染完整 UI，这里可按配置伪装平台。
if (boot.spoofOS) {
  const ua = navigator.userAgent.replace(/Macintosh; Intel Mac OS X [\d_.]+/g, 'Windows NT 10.0; Win64; x64');
  Object.defineProperty(navigator, 'platform', { get: () => boot.spoofOS === 'Windows' ? 'Win32' : boot.spoofOS });
  Object.defineProperty(navigator, 'userAgent', { get: () => ua });
  Object.defineProperty(navigator, 'appVersion', { get: () => ua.replace('Mozilla/', '') });
}

// 讯飞 PC 端的「speex 录音模式」开关（服务端 systemConfig.stic_record_enable_speex=1）。
// 开着的时候页面会把录音流声明成 format:"speex"，并期待原生插件吐 speex 帧 ——
// Windows 用讯飞自己的音频引擎能编，我们这边没有 speex 编码器，只能给 16k PCM，
// 引擎收到 PCM 当 speex 解 → 判为无有效语音（is_rejected / except_info）→ 分数恒 0。
// 所以把这个开关压成 0：整条链路改走 format:"pcm"，正好是 soundhelper 能提供的裸 PCM 流。
//
// 注意要**深度**处理：这个配置出现在好几种 JSON 里 ——
//   1) 接口响应 {code, body:{...}}；
//   2) pinia 持久化的整个 store {userInfo, ecardInfo, systemConfig:{...}, ...}（persist 路径含 systemConfig）；
//   3) localStorage.systemConfig（另一处 setItem("systemConfig", ...)）。
// 只改顶层会漏掉 2、3，页面仍然按 speex 走。
const SPEEX_KEYS = ['stic_record_enable_speex', 'hd_stic_record_enable_speex'];
let speexFixed = 0;
function fixSpeexFlags(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 6) return;
  SPEEX_KEYS.forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k]) {
      obj[k] = 0;
      speexFixed += 1;
      log.info(`[shim] 强制 ${k}=0（无 speex 编码器，改用 pcm）`);
    }
  });
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    if (v && typeof v === 'object') fixSpeexFlags(v, depth + 1);
  });
}
const origJsonParse = JSON.parse;
JSON.parse = function (text, reviver) {
  const out = origJsonParse.call(JSON, text, reviver);
  try {
    if (typeof text === 'string' && text.indexOf('stic_record_enable_speex') !== -1) {
      fixSpeexFlags(out, 0);
    }
  } catch (e) { /* ignore */ }
  return out;
};

// Windows 壳启动时会把 shell.ini 写进 localStorage.clientConfig，
// 页面用 envConfig('C_Version') 从里面取版本号（否则「版本号 v」后面是空的），
// 另外 EnvType 决定环境标识（1=生产）。这里照做一次，保持与官方客户端一致。
try {
  const cfg = Object.assign({}, boot.shellConfig);
  if (!cfg.C_Version) cfg.C_Version = String(cfg.ClientVersion || '');
  if (cfg.EnvType === undefined || cfg.EnvType === '') cfg.EnvType = 1;
  const prev = JSON.parse(localStorage.getItem('clientConfig') || '{}');
  localStorage.setItem('clientConfig', JSON.stringify(Object.assign({}, prev, cfg)));
  if (boot.spoofOS === 'Windows' && !localStorage.getItem('os')) {
    localStorage.setItem('os', 'Windows');
  }
} catch (e) { /* localStorage 不可用时忽略 */ }

// 注入 cef
window.cef = bridge.createCefObject();

// 页面加载前先挂一个兜底：未捕获异常写日志，便于排查桥接问题
window.addEventListener('error', (e) => {
  log.error(`[page] ${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  log.warn(`[page] unhandled rejection: ${(e.reason && (e.reason.message || e.reason)) || ''}`);
});

// 调试模式：把 console.error/warn 收集到 window.__etsErrs，便于用 ETS_JS 一次性取回。
// Vue 的 setup 异常会被框架内部捕获后只走 console.error，光看主进程日志拿不到堆栈。
if (boot.debug) {
  window.__etsErrs = [];
  const push = (s) => {
    try {
      window.__etsErrs.push(String(s).slice(0, 1200));
      if (window.__etsErrs.length > 100) window.__etsErrs.shift();
    } catch (e) { /* ignore */ }
  };
  const fmtArg = (x) => {
    if (x instanceof Error) return x.stack || x.message;
    if (x && typeof x === 'object') { try { return JSON.stringify(x); } catch (e) { return String(x); } }
    return String(x);
  };
  ['error', 'warn'].forEach((k) => {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      push(`console.${k}: ` + a.map(fmtArg).join(' '));
      orig(...a);
    };
  });
}

// 最近一次「页面自己上报拖动」的时间，用来给下面的兜底拖动让位
let lastPageDragAt = 0;

// 把 HttpHelper 进度回调 id 收集起来（页面 init 时传入）
const origSend = bridge.sendMessage.bind(bridge);
bridge.sendMessage = (cbId, target, func, args) => {
  if (String(target).toLowerCase() === 'httphelper' && func === 'init') {
    try {
      const p = JSON.parse(args);
      if (p && p.httpload_progress_callback_id) progressIds.push(p.httpload_progress_callback_id);
    } catch (e) { /* ignore */ }
  }
  if (String(target).toLowerCase() === 'appcontroller' && func === 'move') {
    lastPageDragAt = Date.now();
  }
  return origSend(cbId, target, func, args);
};

// ---------- 窗口拖动（唯一实现） ----------
// 页面原本的拖动走 appcontroller.move，但它传的是 clientX/clientY，而且只在
// `document.getElementById(topDomId)` 上绑了 mousedown —— 隐私弹窗、静态子窗口这些
// 没有该 canvas 的页面就完全拖不动。这里统一在顶部条接管，用真实屏幕坐标做绝对定位：
// 窗口新位置 = 按下时的窗口位置 + (当前鼠标 - 按下时鼠标)，掉帧也不会累积误差。
(function installDragFallback() {
  const BAR = 60;          // 顶部可拖区域高度
  const NO_DRAG = 'input,textarea,select,button,a,[role="button"],[contenteditable="true"],' +
    '.icon-close,.nav-close,.el-dialog__headerbtn';
  let pending = null;

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.clientY > BAR) return;
    if (e.target && e.target.closest && e.target.closest(NO_DRAG)) return;
    pending = { x: e.screenX, y: e.screenY, moved: false };
  }, true);

  window.addEventListener('mousemove', (e) => {
    if (!pending) return;
    const dx = e.screenX - pending.x;
    const dy = e.screenY - pending.y;
    if (!pending.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    pending.moved = true;
    ipcRenderer.invoke('win:drag', {
      start: { screenX: pending.x, screenY: pending.y },
      end: { screenX: e.screenX, screenY: e.screenY }
    });
  }, true);

  const stop = () => { pending = null; };
  window.addEventListener('mouseup', stop, true);
  window.addEventListener('blur', stop, true);
})();

// 调试入口：控制台里 __etsShell.stats() 看桥接统计
window.__etsShell = {
  version: boot.version,
  stats: () => bridge.stats,
  log,
  // 精确拖动（排查用）：__etsShell.drag({screenX:600,screenY:200},{screenX:700,screenY:260})
  drag: (start, end) => ipcRenderer.invoke('win:drag', { start, end }),
  winAction: (action) => ipcRenderer.invoke('win:action', action)
};

log.info(`[shell] 桥接层已注入，home=${boot.homeUrl}`);


// ---------- 接口异常提示条 ----------
// 页面在接口 4xx 时会静默失败（例如签名不通过），这里补一条可见提示
ipcRenderer.on('shell:notice', (e, info) => {
  try {
    if (!info || info.kind !== 'api-rejected') return;
    if (document.getElementById('__ets_notice')) return;
    const bar = document.createElement('div');
    bar.id = '__ets_notice';
    bar.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
      'max-width:640px', 'z-index:2147483647', 'padding:12px 18px', 'border-radius:10px',
      'background:rgba(32,33,36,.94)', 'color:#fff', 'font:13px/1.6 -apple-system,PingFang SC,sans-serif',
      'box-shadow:0 8px 28px rgba(0,0,0,.28)', 'text-align:center'
    ].join(';');
    const detail = info.detail ||
      '请求签名未通过，页面数据无法加载。按 ⌘L 查看桥接日志，或查看 README 的「签名」章节。';
    bar.innerHTML = '接口请求被服务端拒绝（HTTP ' + info.status + '）' +
      '<div style="opacity:.72;font-size:12px;margin-top:4px">' + detail + '</div>';
    document.body.appendChild(bar);
    setTimeout(() => bar.remove(), 20000);
  } catch (err) { /* ignore */ }
});

// ---------- 窗口关闭相关（不注入任何自绘 UI，保持原版外观） ----------
// 主界面右上角的 × 是页面自绘的 .icon-close.nav-close，原版什么样就保持什么样；
// 隐私政策 / 用户协议等静态页在独立窗口里打开，自带 macOS 红黄绿按钮。
// 这里只补两件「看不见」的事，不动任何视觉：
//   1) 静态页按 Esc 关窗；
//   2) 认证流程页的 × 调的是 router.back()，没有历史时点了没反应 —— 加一层兜底。
(function installCloseHelpers() {
  'use strict';
  const SPA_MARK = 'ets-student-pc-web/index.html';
  const isSpa = () => location.href.indexOf(SPA_MARK) >= 0;

  // Esc：静态页直接关窗（SPA 交给页面自己处理）
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || isSpa()) return;
    ipcRenderer.invoke('win:action', 'close');
  }, true);

  // 认证流程页的 X 兜底：点了 900ms 还停在 privacy/register，就回登录页
  function guardNavClose() {
    if (!isSpa()) return;
    const nav = document.querySelector('.nav-close');
    if (!nav || nav.dataset.etsGuard) return;
    nav.dataset.etsGuard = '1';
    nav.addEventListener('click', () => {
      const before = location.href;
      setTimeout(() => {
        // 点了 X 之后路由没变、还停在认证流程里，说明 router.back() 没有历史可回
        if (location.href === before && /#\/auth\//.test(location.href)) {
          location.hash = '#/auth/login';
        }
      }, 900);
    }, { capture: true, passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', guardNavClose, { once: true });
  } else { guardNavClose(); }
  setInterval(guardNavClose, 1500); // nav 会被 Vue 重建，dataset 标记会丢，定时补挂
})();

// ---------- 记住密码（壳层兜底） ----------
// 配套 main.js 的 remember:* IPC。密码只经本地 IPC 交给主进程存入系统
// 钥匙串，不写 localStorage、不写日志、不落明文文件。
(function installRememberLogin() {
  'use strict';
  const isLoginPage = () => /#\/auth\/login/.test(location.href);
  const isAuthFlow = () => /#\/auth\//.test(location.href);
  let restored = false;
  let pending = null;
  let wasLogin = isLoginPage();

  function findFields() {
    const inputs = Array.prototype.slice.call(document.querySelectorAll('input'));
    const user = inputs.filter((el) => /手机号|用户名|邮箱/.test(el.placeholder || ''))[0];
    const pwd = inputs.filter((el) => el.type === 'password')[0];
    let remember = null;
    const label = Array.prototype.slice.call(document.querySelectorAll('span,label,div'))
      .filter((el) => el.children.length === 0 && el.textContent.trim() === '记住密码')[0];
    if (label) {
      let box = label.closest('label') || label.parentElement;
      for (let i = 0; i < 3 && box; i += 1, box = box.parentElement) {
        const cb = box.querySelector && box.querySelector('input[type="checkbox"]');
        if (cb) { remember = cb; break; }
      }
    }
    return { user: user, pwd: pwd, remember: remember };
  }

  // Vue 的 v-model 监听的是原生 input 事件，必须用原型上的 setter 赋值
  function fill(el, value) {
    if (!el || value === undefined || value === null) return;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function capture() {
    if (!isLoginPage()) return;
    const f = findFields();
    if (!f.user || !f.pwd) return;
    const account = (f.user.value || '').trim();
    const pwd = f.pwd.value || '';
    if (!account || !pwd) return;
    pending = { account: account, pwd: pwd, remember: f.remember ? f.remember.checked : true };
  }

  function restore() {
    if (restored || !isLoginPage()) return;
    const f = findFields();
    if (!f.user || !f.pwd) return;
    restored = true;
    ipcRenderer.invoke('remember:get').then((saved) => {
      if (!saved || !saved.account) return;
      fill(f.user, saved.account);
      if (saved.pwd) fill(f.pwd, saved.pwd);
      if (f.remember && !f.remember.checked) f.remember.click();
      log.info('[remember] 已回填上次的登录信息');
    }).catch(() => {});
  }

  document.addEventListener('input', function (e) {
    if (!isLoginPage()) return;
    const t = e.target;
    if (t && (t.type === 'password' || /手机号|用户名|邮箱/.test(t.placeholder || ''))) capture();
  }, true);
  document.addEventListener('click', function () { if (isLoginPage()) capture(); }, true);

  setInterval(function () {
    const now = isLoginPage();
    // 离开登录页且不再处于认证流程 -> 认为登录成功，此时才落盘
    if (wasLogin && !now && !isAuthFlow() && pending) {
      const data = pending;
      pending = null;
      if (data.remember) ipcRenderer.invoke('remember:set', data).catch(() => {});
      else ipcRenderer.invoke('remember:clear').catch(() => {});
    }
    if (now && !wasLogin) restored = false; // 退出登录后再次回到登录页时重新回填
    if (now && !restored) restore();
    wasLogin = now;
  }, 600);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restore, { once: true });
  } else { restore(); }
})();
