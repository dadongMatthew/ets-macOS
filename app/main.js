'use strict';
/**
 * E听说 macOS 外壳（Electron）
 *
 * 逆向自 EtsSetup5.7.9.exe（NSIS 打包的 CEF 客户端）：
 *   1. ETSShell.exe 是 CEF 宿主，读 shell.ini 里的 HomeUrl，直接打开线上网页；
 *   2. 网页通过注入的 cef.message 扩展调用 9 个原生插件（窗口/文件/网络/音频/SQLite/压缩/外壳…）；
 *   3. 真正的内容与业务全在 https://statics.ets100.com 上，本地只做“壳”。
 * 因此 macOS 版不需要重做网页，只需要把 cef.message 这一层用 Electron 复刻出来。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
const { execFile } = require('child_process');
const util = require('./bridge/util');

const APP_ROOT = path.join(__dirname, '..');
const RESOURCES = path.join(APP_ROOT, 'resources');

// ---------- 读取 shell.ini ----------
const iniPath = path.join(__dirname, 'shell.ini');
let ini = {};
try {
  ini = util.parseIni(fs.readFileSync(iniPath, 'utf8'));
} catch (e) {
  console.error('读取 shell.ini 失败:', e.message);
}
const shellConfig = util.shellConfigToJson(ini);
// ETS_HOME 用于本地联调（例如指向自测页面），正常运行时读 shell.ini
const HOME_URL = process.env.ETS_HOME || shellConfig.HomeUrl ||
  'https://statics.ets100.com/ets-student-pc-web/index.html';

// ---------- 目录规划 ----------
const DATA_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'E听说');

/**
 * 调试开关读取：环境变量优先，其次读 <数据目录>/debug.json。
 * 用 `open -n E听说.app` 启动时拿不到自定义环境变量，所以留了文件这条通道。
 *   { "dump": "/tmp/live", "dump_marks": "9000,18000", "dump_html": 1, "shot_exit": 1 }
 */
let debugOpts = {};
try {
  debugOpts = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'debug.json'), 'utf8')) || {};
} catch (e) { debugOpts = {}; }
function opt(name, def) {
  if (process.env[name] !== undefined) return process.env[name];
  const key = String(name).toLowerCase().replace(/^ets_/, '');
  if (debugOpts[key] !== undefined && debugOpts[key] !== null) return String(debugOpts[key]);
  return def;
}
// 有任意调试开关就打开页面的错误收集（preload 会据此挂 console 钩子）
const DEBUG_ON = !!(process.env.ETS_DUMP || process.env.ETS_JS ||
  debugOpts.dump || debugOpts.js);
/**
 * 是否显示菜单里的调试项（重新加载 / 打开桥接日志 / 接口签名自检 / 开发者工具）。
 * 发布给学生的安装包默认**全部隐藏**，并顺带关掉 webContents 的 devtools。
 * 现场排查：环境变量 ETS_DEBUG_MENU=1 启动，或往 <数据目录>/debug.json 写 {"debug_menu":1}。
 */
const DEBUG_MENU = !!(process.env.ETS_DEBUG_MENU || debugOpts.debug_menu || debugOpts.menu);
const LOG_ROOT = path.join(DATA_ROOT, 'logs');
const PATHS = {
  // 页面用 cef.message.getExePath() 拼 `${EXE_PATH}/packages`、`${EXE_PATH}/mq_server/...`，
  // 这里指向代码目录（开发时是 app/，打包后是 Resources/app/app），两个位置结构一致
  appRoot: __dirname,
  resources: RESOURCES,
  dataRoot: DATA_ROOT,
  logRoot: LOG_ROOT,
  ffmpeg: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', path.join(RESOURCES, 'ffmpeg')]
    .find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || ''
};
['', 'localdata', 'logs', 'common/material', 'download', 'temp'].forEach((d) => {
  try { fs.mkdirSync(path.join(DATA_ROOT, d), { recursive: true }); } catch (e) { /* ignore */ }
});

// 运行时数据（缓存/Cookie/单实例锁）放到应用数据目录，避免污染 ~/Library
app.setName('E听说');
app.setPath('userData', process.env.ETS_USER_DATA || path.join(DATA_ROOT, 'runtime'));

const log = util.createLogger(LOG_ROOT, 'bridge');
log.info(`[shell] 启动 E听说 macOS 壳 v${app.getVersion()}，home=${HOME_URL}`);

// 首次运行：把随包的空数据库放到数据目录
try {
  const dbTarget = path.join(DATA_ROOT, 'localdata', 'ETS.db');
  const dbTpl = path.join(RESOURCES, 'ETS.db');
  if (!fs.existsSync(dbTarget) && fs.existsSync(dbTpl)) {
    fs.copyFileSync(dbTpl, dbTarget);
    log.info('[shell] 初始化 localdata/ETS.db');
  }
} catch (e) { /* ignore */ }

// ---------- 自定义协议：让 https 页面也能读取本地音频 ----------
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'etsfile',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true }
  },
  {
    // Windows 壳里页面用 stic://file.iflytek.com/... 读安装目录内的静态资源
    scheme: 'stic',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true }
  }
]);

// 页面里有部分资源仍是 http://（Windows 的 CEF 默认放行），这里按配置放行混合内容
if (Number(shellConfig.AllowInsecureContent ?? 1)) {
  app.commandLine.appendSwitch('allow-running-insecure-content');
}
// 关闭 GPU 时可规避部分虚拟机/远程桌面下的黑屏
if (Number(shellConfig.DisableGPU || 0)) app.disableHardwareAcceleration();

// Chromium/Node 的致命错误（V8 OOM、CHECK 失败…）只会写 stderr，
// 而 `open E听说.app` 会把 stderr 丢掉。落到文件里才能在渲染进程崩溃后看到真正原因。
try {
  app.commandLine.appendSwitch('enable-logging', 'file');
  app.commandLine.appendSwitch('log-file', path.join(LOG_ROOT, 'chromium.log'));
} catch (e) { /* ignore */ }

// 页面登录后要一次性加载大量资源，默认 V8 堆偏紧，适当放宽
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

let mainWindow = null;
let signProbeResult = null;
/**
 * 拖动状态，按 webContents.id 分开存（主窗口 + 协议子窗口可能同时在拖）。
 * 页面每帧都会把「按下点 startPoint」和「当前点 endPoint」一起发过来，
 * 所以这里用「拖动开始时的窗口位置 + 位移」做绝对定位，掉帧也不会累积误差。
 */
const dragStates = new Map();
function dragStateOf(id) {
  let s = dragStates.get(id);
  if (!s) { s = { winStart: null, mouseStart: null, lastX: null, lastY: null, ts: 0, userMoved: false }; dragStates.set(id, s); }
  return s;
}
/** 页面给的是 clientX/clientY（{x,y}），个别版本给 screenX/screenY，这里都兼容 */
function pickXY(pt, screenKey, clientKey) {
  if (!pt) return null;
  const v = typeof pt[screenKey] === 'number' ? pt[screenKey]
    : (typeof pt[clientKey] === 'number' ? pt[clientKey] : NaN);
  return Number.isFinite(v) ? v : null;
}
let crashCount = 0;

// 同一个窗口的 webPreferences 供新窗口复用（支付/帮助页等）
function webPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: false, // 必须：页面插件直接引用全局 cef
    nodeIntegration: false,
    sandbox: false,
    // 页面是 https，但联网自检用的是 http（file.fei.ets100.com/network_test），
    // Chromium 默认按混合内容拦截，会导致自检失败、登录页空白。
    // 这里按 shell.ini 的 WebSecurity 开关处理（0 = 放行混合内容）。
    webSecurity: Number(shellConfig.WebSecurity ?? 0) !== 0,
    spellcheck: false,
    backgroundThrottling: false,
    // 发布版不留调试入口：没有调试菜单时连 devtools 一起关掉
    devTools: DEBUG_MENU
  };
}

/**
 * 是否为「纯展示静态页」：隐私政策、用户注册协议、购买码、作业报告等 .html。
 *
 * Windows 壳用带系统标题栏的子窗口打开这类页面，用户点系统 X 就能关；
 * 而我们的窗口是 frame:false 无边框，静态页自身不带任何关闭控件 ——
 * 一旦它出现在主窗口或无边框子窗口里，用户就既看不到也点不到「关闭」，直接卡死。
 * 因此这类页面一律开成「带原生标题栏」的独立子窗口（macOS 红黄绿按钮可关闭），
 * preload 里还会再补一个页面内的「× 关闭」按钮做双保险。
 */
function isStaticDoc(target) {
  try {
    const u = new URL(target);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (target.split('#')[0] === HOME_URL.split('#')[0]) return false; // 主 SPA 不算
    return /\.html?$/i.test(u.pathname);
  } catch (e) { return false; }
}

function createWindow(url, opts = {}) {
  const win = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 780,
    minHeight: 480,
    center: true, // 不指定 x/y 时 macOS 会把窗口丢到屏幕左上角，这里显式居中
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    title: shellConfig.AppTitle || '讯飞E听说',
    webPreferences: webPreferences(),
    ...opts
  });

  win.once('ready-to-show', () => {
    // 无边框窗口在 show 之前调 center() 并不可靠（macOS 会按默认位置放到左上角），
    // 这里直接用当前尺寸算一次 workArea 居中，再 show。
    try {
      const disp = require('electron').screen.getPrimaryDisplay().workArea;
      const b = win.getBounds();
      win.setBounds({
        x: Math.round(disp.x + Math.max(0, (disp.width - b.width) / 2)),
        y: Math.round(disp.y + Math.max(0, (disp.height - b.height) / 2)),
        width: b.width,
        height: b.height
      });
    } catch (e) { /* ignore */ }
    win.show();
    // 注意：shell.ini 的值全是字符串，'0' 在 JS 里是 truthy，必须显式比较
    if (String(shellConfig.WindowMaximize) === '1') win.maximize();
  });

  /** 纯展示页统一开成「带原生标题栏」的子窗口：macOS 红黄绿按钮一定能关掉 */
  function openDocWindow(target) {
    log.info(`[shell] 静态展示页开独立窗口（带系统关闭按钮）: ${target}`);
    createWindow(target, { frame: true, width: 1100, height: 760, minWidth: 760, minHeight: 520 });
  }

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!/^https?:/i.test(target)) return { action: 'deny' };
    // 隐私条款 / 用户协议等纯展示页：不再塞进无边框窗口，否则没有关闭控件
    if (isStaticDoc(target)) { openDocWindow(target); return { action: 'deny' }; }
    if (/^https?:\/\/([^/]*\.)?ets100\.com\//i.test(target)) {
      // 需要桥接能力的页面也在应用内开窗，同样保留原生标题栏
      openDocWindow(target);
      return { action: 'deny' };
    }
    shell.openExternal(target);
    return { action: 'deny' };
  });

  // 关键护栏：隐私条款 iframe 里的 <a target="view_window"> 在 openHandler deny 之后，
  // Chromium 有时会把 opener（也就是主窗口）直接导航到目标静态页。
  // 主窗口一旦离开 SPA 就再也没有任何关闭控件，所以这类导航必须拦下来。
  win.webContents.on('will-navigate', (e, target) => {
    if (!win.webContents.getURL()) return; // 首次加载不拦
    if (!isStaticDoc(target)) return;
    e.preventDefault();
    log.info(`[shell] 阻止主窗口被静态页带走，改开独立窗口: ${target}`);
    openDocWindow(target);
  });

  win.webContents.on('did-fail-load', (e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    log.error(`[shell] 页面加载失败 ${validatedURL} (${code} ${desc})`);
    const errPage = path.join(__dirname, 'error.html');
    if (fs.existsSync(errPage)) win.loadFile(errPage);
  });

  win.webContents.on('did-finish-load', () => {
    if (signProbeResult && !signProbeResult.ok) {
      win.webContents.send('shell:notice', {
        kind: 'api-rejected',
        status: signProbeResult.results.map((r) => `${r.protocol}:${r.status}`).join(' / '),
        detail: '签名 v1 / v2 均未通过，接口数据加载不到。可换一个网络（如手机热点）重开本应用再试。'
      });
    }
  });

  win.webContents.on('render-process-gone', (e, details) => {
    const d = details || {};
    log.error(`[shell] 渲染进程退出: ${d.reason} exitCode=${d.exitCode} crashed=${d.crashed}`);
    log.error(`[shell] 崩溃时页面: ${win.webContents.getURL()}`);
    // 崩溃原因（V8 OOM / CHECK 失败 / SIGBUS…）只在 Chromium 自己的日志里，
    // 这里把尾部若干行抄进 bridge 日志，事后排查不用再去翻另一个文件。
    try {
      const chromiumLog = path.join(app.getPath('userData'), 'electron_debug.log');
      if (fs.existsSync(chromiumLog)) {
        const tail = fs.readFileSync(chromiumLog, 'utf8').split(/\r?\n/).slice(-120);
        tail.filter((l) => /FATAL|ERROR|OOM|out of memory|CHECK|SIGBUS|SIGSEGV|crash/i.test(l))
          .slice(-30)
          .forEach((l) => log.error(`[chromium] ${l.slice(0, 500)}`));
      }
    } catch (err) { /* ignore */ }
    // 崩溃后 Chromium 只会留一个白窗，这里自动恢复一次（最多 3 次，避免死循环）
    if (d.reason && d.reason !== 'clean-exit' && crashCount < 3) {
      crashCount += 1;
      log.warn(`[shell] 第 ${crashCount} 次自动恢复页面…`);
      setTimeout(() => {
        try { win.reload(); } catch (err) { /* ignore */ }
      }, 1200);
    }
  });

  // 页面 console 落到桥接日志，方便排查（LogLevel>=2 时才记 info）
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const text = `[page:${level}] ${message}`;
    if (level >= 2) log.error(text);
    else if (Number(shellConfig.LogLevel || 1) >= 2) log.info(text);
    if (logWindow && !logWindow.isDestroyed()) {
      logWindow.webContents.send('log:line', `${new Date().toISOString()} ${text}`);
    }
  });

  win.on('closed', () => {
    if (win === mainWindow) mainWindow = null;
  });

  win.loadURL(url);

  // 自测用：加载完成后截图并退出（ETS_SHOT=/path/xx.png）
  const shotPath = opt('ETS_SHOT');
  if (shotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(shotPath, img.toPNG());
          log.info(`[shell] 截图已保存 ${shotPath}`);
        } catch (e) {
          log.error(`[shell] 截图失败 ${e.message}`);
        }
        if (opt('ETS_SHOT_EXIT') === '1') app.quit();
      }, Number(opt('ETS_SHOT_DELAY', 9000)));
    });
  }

  // 调试：在指定时间点执行一段 JS（ETS_JS='...'，ETS_JS_DELAY=10000）
  // 与 dump 一样，did-finish-load 可能因长连接迟迟不触发，这里 dom-ready + 兜底定时器双保险
  const jsCode = opt('ETS_JS');
  if (jsCode) {
    let jsScheduled = false;
    const runJs = () => {
      if (jsScheduled) return;
      jsScheduled = true;
      setTimeout(() => {
        win.webContents.executeJavaScript(jsCode)
          .then((r) => log.info(`[shell] ETS_JS 执行结果: ${JSON.stringify(r)}`))
          .catch((e) => log.warn(`[shell] ETS_JS 失败: ${e.message}`));
      }, Number(opt('ETS_JS_DELAY', 10000)));
    };
    win.webContents.once('dom-ready', runJs);
    setTimeout(runJs, 12000);
  }

  // 调试：按时间点抓截图 + DOM 快照（ETS_DUMP=/tmp/prefix）
  const dumpPrefix = opt('ETS_DUMP');
  if (dumpPrefix) {
    const marks = String(opt('ETS_DUMP_MARKS', '5000,12000,20000')).split(',').map(Number);
    const dumpOnce = async (i, ms) => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(`${dumpPrefix}-${i}.png`, img.toPNG());
        const info = await win.webContents.executeJavaScript(`(() => {
          const login = document.querySelector('.login');
          const frames = [...document.querySelectorAll('iframe')].map(f => ({src: f.src, w: f.clientWidth, h: f.clientHeight}));
          const inputs = document.querySelectorAll('input').length;
          const txt = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 600);
          return {
            url: location.href,
            inputs,
            htmlLen: document.body.innerHTML.length,
            frames,
            loginHtml: login ? login.innerHTML.slice(0, 2000) : null,
            loginRect: login ? login.getBoundingClientRect().toJSON() : null,
            loginStyle: login ? (() => { const s = getComputedStyle(login); return {display: s.display, visibility: s.visibility, opacity: s.opacity, h: s.height}; })() : null,
            vueApp: !!document.querySelector('#app'),
            errs: (window.__etsErrs || []).slice(-40),
            txt
          };
        })()`);
        fs.writeFileSync(`${dumpPrefix}-${i}.json`, JSON.stringify(info, null, 2));
        if (opt('ETS_DUMP_HTML')) {
          const html = await win.webContents.executeJavaScript('document.body.innerHTML');
          fs.writeFileSync(`${dumpPrefix}-${i}.html`, html);
        }
        log.info(`[shell] dump ${ms}ms -> ${dumpPrefix}-${i}.*`);
      } catch (e) {
        log.warn(`[shell] dump 失败: ${e.message}`);
      }
    };
    // did-finish-load 可能因为长连接迟迟不触发，这里用 dom-ready + 兜底定时器双重保险
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      marks.forEach((ms, i) => setTimeout(() => dumpOnce(i, ms), ms));
    };
    win.webContents.once('dom-ready', schedule);
    setTimeout(schedule, 12000);
  }

  return win;
}

// ---------- 单实例 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/**
 * 给自定义协议提供本地文件，必须带 content-length + Range 支持。
 * 否则 <audio>/Howler 拿到的 duration 是 Infinity、进度条也拖不动
 * （实测：不带 Range 时 `new Audio(stic://...)` 的 duration = Infinity）。
 */
const MIME_MAP = {
  '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm'
};
function mimeOf(file) {
  return MIME_MAP[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
async function serveLocalFile(file, req) {
  const stat = await fs.promises.stat(file);
  const size = stat.size;
  const headers = {
    'content-type': mimeOf(file),
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'cache-control': 'no-cache'
  };
  const range = req.headers.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      let start = m[1] === '' ? size - Number(m[2] || 0) : Number(m[1]);
      let end = (m[1] === '' || m[2] === '') ? size - 1 : Number(m[2]);
      start = Math.max(0, Math.min(start, size - 1));
      end = Math.max(start, Math.min(end, size - 1));
      const stream = fs.createReadStream(file, { start, end });
      return new Response(Readable.toWeb(stream), {
        status: 206,
        headers: Object.assign({}, headers, {
          'content-range': `bytes ${start}-${end}/${size}`,
          'content-length': String(end - start + 1)
        })
      });
    }
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200,
    headers: Object.assign({}, headers, { 'content-length': String(size) })
  });
}

// 兜底：任何 webContents 遇到自家域名的证书错误都放行（见下面 setCertificateVerifyProc 的说明）
app.on('certificate-error', (event, wc, url, error, certificate, callback) => {
  try {
    const host = new URL(url).hostname;
    if (/(^|\.)ets100\.com$/i.test(host)) {
      event.preventDefault();
      callback(true);
      return;
    }
  } catch (e) { /* ignore */ }
  callback(false);
});

app.whenReady().then(() => {
  // etsfile://local/<绝对路径> -> 本地文件
  protocol.handle('etsfile', async (req) => {
    try {
      const u = new URL(req.url);
      let filePath = decodeURIComponent(u.pathname || '');
      if (filePath.startsWith('/')) filePath = filePath.slice(1);
      if (!filePath.startsWith('/')) filePath = '/' + filePath;
      if (!fs.existsSync(filePath)) return new Response('', { status: 404 });
      return await serveLocalFile(filePath, req);
    } catch (e) {
      return new Response('', { status: 404 });
    }
  });

  // stic://file.iflytek.com/<相对路径> -> 安装目录 / 应用数据目录内的静态资源
  protocol.handle('stic', async (req) => {
    try {
      const u = new URL(req.url);
      let rel = decodeURIComponent(u.pathname || '').replace(/\\/g, '/').replace(/^\/+/, '');
      const candidates = [path.join(APP_ROOT, rel), path.join(DATA_ROOT, rel), path.join(RESOURCES, rel)];

      // 页面会把 Windows 绝对路径直接拼到 stic:// 后面：
      //   normalizeAudioUrl('\\Users\\xxx\\ETS\\1\\material\\content.mp3')
      //     -> 'stic://file.iflytek.com/\\Users\\xxx\\ETS\\1\\material\\content.mp3'
      // 于是 rel 就成了 "Users/xxx/ETS/..." 这样的本机绝对路径。
      // 只按相对路径拼会去 APP_ROOT 下面找，必然 404（Howler 报 onloaderror → 播放失败）。
      // 这里补一个绝对路径候选，并且只放行用户目录 / 应用目录 / 数据目录，避免变成任意文件读取。
      try {
        const abs = path.resolve('/', rel);
        const home = os.homedir();
        const allowed = abs === home || abs.startsWith(home + path.sep) ||
          abs.startsWith(APP_ROOT) || abs.startsWith(DATA_ROOT) || abs.startsWith(RESOURCES);
        if (allowed) candidates.unshift(abs);
      } catch (e) { /* ignore */ }
      for (const file of candidates) {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          return await serveLocalFile(file, req);
        }
      }
      log.warn(`[stic] 404 rel=${rel} 候选=${candidates.join(' | ')}`);
      return new Response('', { status: 404 });
    } catch (e) {
      log.warn(`[stic] 异常 ${req.url}: ${e.message}`);
      return new Response('', { status: 404 });
    }
  });

  // 允许麦克风（口语练习必需）
  const ses = require('electron').session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(['media', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write', 'notifications']
      .includes(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media' || permission === 'audioCapture');

  // 麦克风系统权限：macOS 上没授权时 getUserMedia 拿到的流可能是全 0 的静音数据
  try {
    const { systemPreferences } = require('electron');
    log.info(`[shell] 麦克风权限状态: ${systemPreferences.getMediaAccessStatus('microphone')}`);
    if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      systemPreferences.askForMediaAccess('microphone')
        .then((ok) => log.info(`[shell] 请求麦克风权限: ${ok}`))
        .catch((e) => log.warn(`[shell] 请求麦克风权限失败: ${e.message}`));
    }
  } catch (e) { /* ignore */ }

  // ---------- 证书校验放行（单词发音/课文音频放不出来的根因） ----------
  // 音频都在 http://cdn.subject.ets100.com/media/*.mp3，页面是 https，
  // Chromium 会把 http 的 <audio> 自动升级成 https，但该 CDN 用的是网宿共享证书
  // （CN=default.chinanetcenter.com），跟域名不匹配 -> ERR_CERT_COMMON_NAME_INVALID
  // -> Howler/audio 触发 onerror -> 页面弹“播放失败”。
  // Windows 版 CEF 对这类证书错误是直接放行的，这里只对自家域名做同样处理。
  const ETS_HOST = /(^|\.)ets100\.com$/i;
  ses.setCertificateVerifyProc((req, cb) => {
    if (ETS_HOST.test(req.hostname)) {
      log.info(`[cert] 放行 ${req.hostname}（${req.certificate && req.certificate.subjectName}）`);
      cb(0);
      return;
    }
    cb(-3); // -3 = 走 Chromium 默认校验
  });

  // 网络诊断：把失败请求和 4xx/5xx 的接口调用记进日志（页面报“网络异常”时看这里）
  ses.webRequest.onErrorOccurred((d) => {
    if (d.resourceType === 'xhr' || d.resourceType === 'fetch' || /ets100\.com/.test(d.url)) {
      log.warn(`[net] ${d.error} ${d.method} ${d.url}`);
    }
  });
  // 所有 http://*.ets100.com 统一重定向到 https，避免被 Mixed Content 拦成
  // “requested an insecure XMLHttpRequest endpoint”（entity/content2.json 这类接口会被直接 block）
  const traceApi = !!opt('ETS_TRACE_API');
  if (traceApi) {
    ses.webRequest.onBeforeSendHeaders((d, cb) => {
      if (/api\.ets100\.com/.test(d.url)) {
        log.info(`[api] ${d.method} ${d.url} headers=${JSON.stringify(d.requestHeaders)}`);
      }
      cb({ requestHeaders: d.requestHeaders });
    });
  }
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (d, cb) => {
    if (traceApi && /api\.ets100\.com/.test(d.url) && d.uploadData) {
      const body = d.uploadData.map((x) => x.bytes ? x.bytes.toString('utf8') : '').join('');
      log.info(`[api] body=${body.slice(0, 600)}`);
    }
    const m = /^http:\/\/([^/:?#]+)(?::\d+)?\//i.exec(d.url);
    if (m && ETS_HOST.test(m[1])) {
      cb({ redirectURL: 'https://' + d.url.slice(7) });
      return;
    }
    cb({});
  });

  ses.webRequest.onCompleted((d) => {
    if (d.statusCode >= 400 && (d.resourceType === 'xhr' || d.resourceType === 'fetch')) {
      log.warn(`[net] HTTP ${d.statusCode} ${d.method} ${d.url}`);
      // 接口被服务端拒绝时，让页面弹一条说明，避免出现“白屏没反应”
      if (/api\.ets100\.com/.test(d.url)) {
        BrowserWindow.getAllWindows().forEach((w) => {
          if (!w.isDestroyed()) w.webContents.send('shell:notice', {
            kind: 'api-rejected',
            status: d.statusCode,
            url: d.url
          });
        });
      }
    }
  });

  // 启动本地消息服务（页面启动流程的硬依赖，连不上会卡在空白页）
  try {
    const mq = require('./mq_server/main.js');
    mq.start(__dirname).then((port) => {
      shellConfig.suspensionBallPort = port;
      log.info(`[shell] mq_server 已启动 127.0.0.1:${port}`);
    }).catch((e) => log.warn(`[shell] mq_server 启动失败: ${e.message}`));
  } catch (e) {
    log.warn(`[shell] mq_server 加载失败: ${e.message}`);
  }

  buildMenu();

  // 先探测签名协议（最多等 8 秒），再开窗口，避免页面拿着错协议白跑一轮
  probeSignProtocol()
    .then((r) => { shellConfig.SignProtocol = r.protocol; signProbeResult = r; })
    .catch(() => { /* 探测失败就用默认 */ })
    .finally(() => {
      mainWindow = createWindow(HOME_URL);
    });
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (!mainWindow) mainWindow = createWindow(HOME_URL);
});


// ---------- 接口签名（v1 / v2）----------
/**
 * 逆向结论：sign = md5(pid + time + body)
 *   v1: pid = "grlx"，返回裸的 32 位 hex
 *   v2: pid = "pcWin"，额外带 key_id="202608"、sign_version="2"
 * 两种协议服务端支持情况可能不同，启动时自动探测一次，选能通的那个。
 */
function buildSignHead(protocol) {
  const crypto = require('crypto');
  const payload = [{
    r: 'system/config',
    params: { sign_response: 1, sn: 'test', system: 4, global_client_version: '', checkToken: false }
  }];
  const body = Buffer.from(JSON.stringify(payload)).toString('base64');
  const time = String(Date.now());
  const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');
  // 逆向得到的固定后缀（由 etshelper.pln 内嵌表生成，见 README）
  const SUFFIX = {
    v1: '555ffbe95ccf4e9535a110170b445ab8',
    v2: '94cfbda3fbfef02b93693f8bc153be82'
  };
  if (protocol === 'v2') {
    return {
      body,
      head: {
        version: '1.0', sign: md5('pcWin' + time + body + SUFFIX.v2), pid: 'pcWin', time,
        time_second: Number(time), key_id: '202608', sign_version: '2'
      }
    };
  }
  return {
    body,
    head: { version: '1.0', sign: md5('grlx' + time + body + SUFFIX.v1), pid: 'grlx', time, time_second: Number(time) }
  };
}

function postSystemConfig(protocol, timeoutMs = 8000) {
  const https = require('https');
  const { body, head } = buildSignHead(protocol);
  return new Promise((resolve) => {
    const data = JSON.stringify({ body, head });
    const u = new URL('https://api.ets100.com/system/config');
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST', timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Referer: 'https://statics.ets100.com/',
        Origin: 'https://statics.ets100.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        protocol, sign: head.sign, status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8').slice(0, 300)
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ protocol, sign: head.sign, status: 'timeout', body: '' }); });
    req.on('error', (e) => resolve({ protocol, sign: head.sign, status: 'error', body: e.message }));
    req.end(data);
  });
}

/** 启动时探测：谁能拿到 200 就用谁；都失败则沿用 shell.ini 的配置 */
async function probeSignProtocol() {
  const configured = String(shellConfig.SignProtocol || 'v1').toLowerCase();
  const order = configured === 'v2' ? ['v2', 'v1'] : ['v1', 'v2'];
  // 兜底：无论底层 socket 怎么卡，最多等 12 秒就放行，绝不挡住开窗
  const guard = new Promise((resolve) => setTimeout(() => resolve('guard-timeout'), 12000));
  const race = await Promise.race([
    Promise.all(order.map((x) => postSystemConfig(x))),
    guard
  ]);
  if (race === 'guard-timeout') {
    log.warn('[signprobe] 探测超时，直接沿用配置 ' + configured);
    return { protocol: configured, results: [], ok: false, timeout: true };
  }
  const results = race;
  results.forEach((r) => {
    log.info(`[signprobe] ${r.protocol} pid=${r.protocol === 'v2' ? 'pcWin' : 'grlx'} sign=${r.sign} -> HTTP ${r.status} ${r.body.slice(0, 120)}`);
  });
  const ok = results.find((r) => r.status === 200);
  if (ok) {
    log.info(`[signprobe] 采用 ${ok.protocol} 协议`);
    return { protocol: ok.protocol, results, ok: true };
  }
  log.warn('[signprobe] 两种签名都未通过（非 200），沿用配置 ' + configured);
  return { protocol: configured, results, ok: false };
}

/** 菜单里的手动自检（结果弹窗） */
function runSignSelfTest() {
  return (async () => {
    const r = await probeSignProtocol();
    const lines = r.results.map((x) =>
      `${x.protocol === 'v2' ? 'v2  pid=pcWin' : 'v1  pid=grlx '}  sign=${x.sign}\n   -> HTTP ${x.status}  ${x.body || '(空响应体)'}`);
    lines.push('');
    lines.push(r.ok ? `✅ ${r.protocol} 通过，已自动采用该协议。` : '❌ 两种签名都没通过：可能是当前网络出口被网关拦截（换网络试试），或服务端还要求别的校验。');
    return lines.join('\n');
  })();
}

// ---------- 菜单 ----------
function buildMenu() {
  // 调试项只在 DEBUG_MENU 打开时出现（发布包默认没有这四项）
  const debugItems = DEBUG_MENU ? [
    {
      label: '重新加载页面', accelerator: 'CmdOrCtrl+R',
      click: () => mainWindow && mainWindow.reload()
    },
    {
      label: '打开桥接日志', accelerator: 'CmdOrCtrl+L',
      click: () => openLogWindow()
    },
    {
      label: '接口签名自检（诊断用）',
      click: async () => {
        const win = mainWindow || BrowserWindow.getAllWindows()[0];
        dialog.showMessageBox(win, { type: 'info', message: '正在测试接口签名…', buttons: ['好'], noLink: true })
          .catch(() => {});
        const text = await runSignSelfTest();
        dialog.showMessageBox(win, { type: 'info', title: '接口签名自检', message: '接口签名自检结果', detail: text, buttons: ['好'] })
          .catch(() => {});
      }
    },
    {
      label: '打开开发者工具', accelerator: 'Alt+CmdOrCtrl+I',
      click: () => mainWindow && mainWindow.webContents.openDevTools({ mode: 'detach' })
    },
    { type: 'separator' }
  ] : [];

  const template = [
    {
      label: 'E听说',
      submenu: [
        { role: 'about', label: '关于 E听说' },
        { type: 'separator' },
        ...debugItems,
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let logWindow = null;
function openLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) { logWindow.focus(); return; }
  logWindow = new BrowserWindow({
    width: 900, height: 600, title: '桥接日志',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  logWindow.loadFile(path.join(__dirname, 'log.html'));
  logWindow.on('closed', () => { logWindow = null; });
}

// ---------- IPC：bootstrap ----------
ipcMain.on('bootstrap:config', (event) => {
  event.returnValue = {
    homeUrl: HOME_URL,
    shellConfig,
    paths: PATHS,
    logFile: log.file,
    version: app.getVersion(),
    verbose: Number(shellConfig.LogLevel || 1) >= 2,
    spoofOS: shellConfig.SpoofOS || '',
    debug: DEBUG_ON
  };
});

ipcMain.on('log:write', (event, level, parts) => {
  const text = (parts || []).join(' ');
  if (level === 'ERROR') log.error(text);
  else if (level === 'WARN') log.warn(text);
  else log.info(text);
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.webContents.send('log:line', `${new Date().toISOString()} [${level}] ${text}`);
  }
});

ipcMain.on('shell:openExternal', (event, url) => {
  if (/^https?:/i.test(url || '')) shell.openExternal(url);
});

// 日志窗口里的“打开日志文件”
ipcMain.on('log:reveal', () => {
  shell.showItemInFolder(log.file);
});

// ---------- IPC：窗口 ----------
ipcMain.handle('win:action', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  switch (action) {
    case 'close': win.close(); break;
    case 'maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
    case 'minimize': win.minimize(); break;
    case 'restore': win.unmaximize(); break;
    case 'fullscreen': win.setFullScreen(true); break;
    case 'reduction': win.setFullScreen(false); break;
    case 'hide': win.hide(); break;
    case 'show': win.show(); win.focus(); break;
    default: break;
  }
  return true;
});

ipcMain.handle('win:getPos', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { win_x: 0, win_y: 0, win_w: 0, win_h: 0 };
  const b = win.getBounds();
  return { win_x: b.x, win_y: b.y, win_w: b.width, win_h: b.height };
});

/**
 * 页面在每次路由切换时都会调 set_win_pos，两个坑：
 *  1) 位置字段经常是 null（表示「别动位置」），以前 Number(null) === 0，
 *     于是窗口被反复扔到屏幕左上角 (0,0)，拖走之后下一次路由又被拉回去
 *     —— 表现就是「窗口固定在左上角、无法移动」。
 *  2) 页面是按「Windows 多窗口」设计的，每个路由会带不同的 win_width/win_height
 *     （780x480 / 900x600 / 1000x680）。单窗口壳里照做只会让窗口在路由切换时
 *     忽大忽小地跳，所以尺寸一律不采纳，由 createWindow + 用户手动调整决定。
 *
 * 现在只处理位置：
 *   win_x/win_y 为 null/undefined/非数字 → 保持当前位置
 *   win_x/win_y 都为 -1                  → 居中
 *   其余数字                              → 按给定坐标
 */
ipcMain.handle('win:setPos', (event, p) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  p = p || {};
  const cur = win.getBounds();

  // 尺寸要跟着页面走：页面按 winWidth/winHeight 配置排版，窗口尺寸不一致会导致
  // 内容缩在左上角、右下大片留白。这里做基本的下限保护。
  const rawW = Number(p.win_w != null ? p.win_w : p.win_width);
  const rawH = Number(p.win_h != null ? p.win_h : p.win_height);
  const width = Number.isFinite(rawW) && rawW >= 320 ? Math.round(rawW) : cur.width;
  const height = Number.isFinite(rawH) && rawH >= 240 ? Math.round(rawH) : cur.height;

  const rawX = p.win_x == null ? NaN : Number(p.win_x);
  const rawY = p.win_y == null ? NaN : Number(p.win_y);

  let x = cur.x;
  let y = cur.y;
  if (dragStateOf(event.sender.id).userMoved) {
    // 用户手动拖过窗口之后，页面再来要求居中/定位一律不理，否则拖走就被拉回去
  } else if (rawX === -1 && rawY === -1) {
    const disp = require('electron').screen.getPrimaryDisplay().workArea;
    x = Math.round(disp.x + (disp.width - width) / 2);
    y = Math.round(disp.y + (disp.height - height) / 2);
  } else if (rawX === 0 && rawY === 0) {
    // 页面把「没设置过位置」当成 0 传过来，照做会把窗口拽回屏幕左上角，按未指定处理
  } else {
    if (Number.isFinite(rawX)) x = Math.round(rawX);
    if (Number.isFinite(rawY)) y = Math.round(rawY);
  }
  if (x === cur.x && y === cur.y && width === cur.width && height === cur.height) return true;
  win.setBounds({ x, y, width, height });
  return true;
});

/** 拖拽：页面每次上报当前鼠标屏幕坐标，按增量移动窗口 */
ipcMain.handle('win:drag', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  if (win.isFullScreen()) return false;

  const start = (payload && payload.start) || {};
  const end = (payload && payload.end) || {};
  const sx = pickXY(start, 'screenX', 'x');
  const sy = pickXY(start, 'screenY', 'y');
  const ex = pickXY(end, 'screenX', 'x');
  const ey = pickXY(end, 'screenY', 'y');
  if (sx === null || sy === null || ex === null || ey === null) return false;

  const now = Date.now();
  const st = dragStateOf(event.sender.id);

  // 最大化状态下拖动：先还原窗口（macOS 习惯），下一帧再跟随鼠标
  if (win.isMaximized()) {
    win.unmaximize();
    const b = win.getBounds();
    st.winStart = { x: b.x, y: b.y };
    st.mouseStart = { x: sx, y: sy };
    st.lastX = null;
    st.lastY = null;
    st.ts = now;
    return true;
  }

  // 新一轮拖动：按下点变了，或距上一次上报超过 800ms
  if (!st.mouseStart || st.mouseStart.x !== sx || st.mouseStart.y !== sy || now - st.ts > 800) {
    const b = win.getBounds();
    st.winStart = { x: b.x, y: b.y };
    st.mouseStart = { x: sx, y: sy };
    st.lastX = null;
    st.lastY = null;
  }
  st.ts = now;

  const nx = Math.round(st.winStart.x + (ex - sx));
  const ny = Math.round(st.winStart.y + (ey - sy));
  if (!st.userMoved) {
    st.userMoved = true; // 之后不再接受页面的居中/定位请求
    log.info('[shell] 窗口已被手动拖动，后续忽略页面的定位请求');
  }
  if (nx === st.lastX && ny === st.lastY) return true;
  st.lastX = nx;
  st.lastY = ny;
  const b = win.getBounds();
  win.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
  return true;
});

// ---------- IPC：对话框 ----------
function dialogFilters(p) {
  const filters = [];
  const raw = p.filter || p.filters || p.fileTypes;
  if (Array.isArray(raw) && raw.length) {
    filters.push({ name: '支持的文件', extensions: raw.map((x) => String(x).replace(/^\./, '')) });
  }
  return filters;
}

ipcMain.handle('dialog:save', async (event, p) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showSaveDialog(win, {
    title: p.title || '保存文件',
    defaultPath: p.fileName || p.defaultPath || p.filename || undefined,
    filters: dialogFilters(p)
  });
  return r.canceled ? '' : r.filePath;
});

ipcMain.handle('dialog:open', async (event, p) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, {
    title: p.title || '打开文件',
    properties: ['openFile'],
    filters: dialogFilters(p)
  });
  return r.canceled || !r.filePaths.length ? '' : r.filePaths[0];
});

ipcMain.handle('dialog:openFolder', async (event, p) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, { title: '选择文件夹', properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? '' : r.filePaths[0];
});

// ---------- IPC：剪贴板图片 ----------
ipcMain.handle('clipboard:saveImage', async (event, target) => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return false;
    const file = util.resolvePath(target, DATA_ROOT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, img.toPNG());
    return true;
  } catch (e) {
    log.warn(`[clipboard] 保存图片失败: ${e.message}`);
    return false;
  }
});

// ---------- IPC：音量 ----------
function osa(script) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 4000 },
      (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

ipcMain.handle('volume:get', async () => {
  const v = await osa('output volume of (get volume settings)');
  return Number(v || 0);
});
ipcMain.handle('volume:set', async (event, v) => {
  const val = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  await osa(`set volume output volume ${val}`);
  return true;
});
ipcMain.handle('volume:getMute', async () => {
  const v = await osa('output muted of (get volume settings)');
  return v === 'true';
});
ipcMain.handle('volume:setMute', async (event, m) => {
  await osa(`set volume ${m ? 'with' : 'without'} output muted`);
  return true;
});

// ---------- IPC：进程/命令（仅允许应用目录内的可执行文件） ----------
const EXEC_ALLOW_PREFIX = [APP_ROOT, DATA_ROOT, '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/', '/bin/'];

function firstToken(cmd) {
  const s = String(cmd || '').trim();
  if (s.startsWith('"')) return s.slice(1, s.indexOf('"', 1));
  return s.split(/\s+/)[0];
}

ipcMain.handle('exec:run', async (event, cmd, opts = {}) => {
  const bin = util.toPosix(firstToken(cmd));
  if (!bin) return '';
  const allowed = EXEC_ALLOW_PREFIX.some((p) => bin.startsWith(p));
  if (!allowed) {
    log.warn(`[exec] 拒绝执行应用目录外的命令: ${cmd}`);
    return '';
  }
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', util.toPosix(cmd)], { timeout: opts.wait === false ? 0 : 120000 },
      (err, stdout, stderr) => {
        if (err) log.warn(`[exec] ${cmd} -> ${err.message}`);
        resolve(String(stdout || stderr || '').trim());
      });
  });
});

ipcMain.handle('exec:kill', async (event, name) => {
  if (!name) return '0';
  return new Promise((resolve) => {
    execFile('/usr/bin/pkill', ['-f', String(name)], { timeout: 4000 }, () => resolve('0'));
  });
});

ipcMain.handle('exec:exists', async (event, name) => {
  if (!name) return false;
  return new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-f', String(name)], { timeout: 4000 }, (err) => resolve(!err));
  });
});

// ---------- 记住密码：登录凭据存进 macOS 钥匙串 ----------
// 线上页面原本依赖 Windows CEF 宿主把账号密码写进 localdata/ETS.db 的
// Config(UpdateLoginInfo/LoginInfo)，macOS 壳没有这一层，网页自己的
// saveLoginInfoToDB 又因拿不到 IndexedDB 记录而从不触发，导致「记住密码」
// 永远没有数据来源。这里由壳接管：preload 在登录页捕获表单，成功后存入
// 系统钥匙串；下次启动由 preload 填回输入框。密码不写日志、不落明文文件。
const KC_SERVICE = 'E听说 macOS Shell Login';
const KC_ACCOUNT = 'ets-student-login';

function keychain(args) {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', args, { timeout: 10000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || ''),
        err: String(stderr || '').trim()
      }));
  });
}

ipcMain.handle('remember:get', async () => {
  const r = await keychain(['find-generic-password', '-s', KC_SERVICE, '-a', KC_ACCOUNT, '-w']);
  if (!r.ok) return null;
  try {
    const data = JSON.parse(r.out.trim());
    return data && data.account ? data : null;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('remember:set', async (event, data) => {
  if (!data || !data.account || !data.pwd) return false;
  const json = JSON.stringify({ account: String(data.account), pwd: String(data.pwd) });
  // -T 只授权 security 自己读取，避免每次启动弹出钥匙串授权框
  const r = await keychain(['add-generic-password', '-U', '-T', '/usr/bin/security',
    '-s', KC_SERVICE, '-a', KC_ACCOUNT, '-w', json]);
  if (r.ok) log.info('[remember] 登录凭据已存入钥匙串');
  else log.warn(`[remember] 钥匙串写入失败: ${r.err}`);
  return r.ok;
});

ipcMain.handle('remember:clear', async () => {
  await keychain(['delete-generic-password', '-s', KC_SERVICE, '-a', KC_ACCOUNT]);
  log.info('[remember] 已清除钥匙串中的登录凭据');
  return true;
});
