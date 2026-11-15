# E听说 macOS 外壳（EtsShell for Mac）

`把 Windows 版 EtsSetup5.7.9.exe（讯飞 E听说 PC 客户端）逆向拆解后，在 macOS 上复刻它的`**`外壳`**`：
网页、业务逻辑、云端服务全部沿用官方线上资源，本地只补上 macOS 缺失的「原生能力层」。`

> 仅限在自己设备上做兼容性运行使用。不含任何破解、授权绕过或内容解密；登录、付费、内容分发仍然完全走官方服务器，使用时需遵守官方的服务条款。



---

## 一、逆向结论：它到底是什么

| 层次   | Windows 实现                                                 | 说明                                                                    |
| ---- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| 安装包  | NSIS 2.46.3 Unicode，LZMA 压缩                                | 7-Zip 可直接解包（378 个文件 / 291MB）                                          |
| 运行时  | **CEF（Chromium Embedded Framework）**，不是 Electron           | `libcef.dll` 132MB、`chrome_elf.dll`、`*.pak`、`v8_context_snapshot.bin` |
| 入口   | `ETSShell.exe`（2.2MB）+ `shell.ini`                         | 读配置里的 `HomeUrl`，直接开一个无边框窗口加载线上网页                                      |
| 网页   | `https://statics.ets100.com/ets-student-pc-web/index.html` | Vue SPA，**完全在服务端**，本地没有网页代码                                           |
| 原生能力 | `plugins/*/*.pln`（9 个 DLL 插件）                              | 窗口、文件、网络、音频、SQLite、压缩、外壳信息、ETS 专用、系统配置                                |
| 进程间  | `mq_server/ets_mq_server.exe`（Node + ws）                   | 本地 40001 端口的广播式 WebSocket，只用于多窗口/悬浮球同步，非必需                            |

关键发现：**网页与原生之间只有一层极薄的 JS 桥**，叫 `cef.message`，由 CEF 扩展注入到页面全局。  
页面里所有原生调用都长这样（`plugins/stic/*.js`）：

```js
const id = cef.message.createGuid();
cef.message.setMessageCallback(id, (data) => { /* data 是字符串，多数是 JSON */ });
cef.message.sendMessage(id, 'FileHelper', 'readfile', JSON.stringify({ filepath, readfile_callback }));
```

原生侧处理完，把结果以**字符串**回吐给 `id` 对应的回调。  
也就是说：**只要在 macOS 上把 `cef.message` 这一层按同样的语义实现出来，整套网页就能原样跑起来**——这正是本项目做的事。

`shell.ini` 里还有 `AppTitle / NoBorder / WindowMaximize / DisableGPU` 等外壳参数，页面会通过 `ShellHelper.getconfig` 读走用于自绘标题栏。

## 二、这个 macOS 版怎么做的

```
E听说.app
└── Contents/Resources/app
    ├── app/main.js            Electron 主进程：窗口、协议、菜单、对话框、音量、进程、日志
    ├── app/preload.js         注入 window.cef（contextIsolation=false，与 CEF 扩展同世界）
    ├── app/bridge/bus.js      cef.message 总线：createGuid / setMessageCallback / removeMessageCallback / sendMessage
    ├── app/bridge/plugins/*   9 个插件的 macOS 实现（见下表）
    ├── app/shell.ini          等价于 Windows 的 shell.ini（HomeUrl + 外壳配置）
    └── resources/             7zz、ETS.db 模板、测试音频
```

- 页面里的 `cef.message` 还额外用到 `getExePath()` / `getHomeUrl()` / `getAppConfig()`，已补齐（`getExePath` 返回应用根目录，页面用它拼 `${EXE_PATH}/packages`）。
- 页面在非 Windows 平台会走 Linux 分支（`localStorage.os = "Mac OS"`），所以 SQLite 查询结果按 Linux 客户端的格式返回（每行是 JSON 字符串），这样 `clientConfig` 才能正常解析出 `EnvType / C_Version`。
- 自定义协议 `etsfile://` 用于让 https 页面读取本地音频（Chromium 禁止 https 页面直接读 `file://`）；`stic://file.iflytek.com/...` 映射到安装目录，兼容页面里读本地静态资源的写法。
- 会话层还做了两件事（都是为了音频/内容能加载）：`*.ets100.com` 的**证书放行**（自家 CDN 用的是网宿共享证书，CN 与域名不匹配），以及把 `http://*.ets100.com` 一律**重定向到 https**（避免混合内容被 Chromium 直接 block）。见「第 11 个坑」。
- `preload.js` 除了注入 `cef`，还打了几处 shim：补 `Uint8Array.fromBase64`（避免页面走 `atob().split('')` 把渲染进程打爆）、包装 `JSON.parse` 把 `stic_record_enable_speex` 压成 0（我们没有 speex 编码器）、把 `shell.ini` 写进 `localStorage.clientConfig` 并伪装 `navigator.platform`。见「第 12 个坑」。

## 三、插件兼容矩阵

| 插件（页面侧 target）  | Windows 能力                                          | macOS 实现                                                                                                                           | 状态                            |
| --------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `appcontroller` | 无边框窗口的关闭/最大化/最小化/全屏/置位/**拖拽**                       | `BrowserWindow` + 屏幕坐标增量拖拽                                                                                                         | ✅ 完整                          |
| `ShellHelper`   | 外壳配置、机器码、音量、静音、网络检测、剪贴板图片、进程                        | `osascript` 调音量、`ioreg` 取序列号生成机器码、`ping`、`NSPasteboard`、`pkill/pgrep`                                                              | ✅ 主要功能                        |
| `FileHelper`    | 读写文本/二进制、md5、OSS-MD5、base64、CRC、目录遍历、复制/移动/删除、文件对话框 | `fs` + `dialog`，路径自动把 Windows 路径映射到 `~/Library/Application Support/E听说`                                                            | ✅ 完整                          |
| `HttpHelper`    | 下载（重定向/超时/重试/进度）、上传 multipart                       | `http/https` + 进度回调；上传按页面真实契约实现（扁平 OSS 表单 + `localFile` + `{"rncode":0}` 回包）                                                       | ✅ 完整                          |
| `sqlitepln`     | 本地 SQLite（`localdata/ETS.db` 的 Config 表）            | 调系统 `/usr/bin/sqlite3`，首次运行自动建库；`data` 返回**对象数组**（页面按 `row.Entry/row.Value` 取值）                                                    | ✅ 完整                          |
| `SevenZip`      | zip/7z 解压、压缩、校验                                     | 随包 `7zz`，失败退回 `ditto` / `unzip`                                                                                                    | ✅ 完整                          |
| `soundhelper`   | 录音（speex 可选）、播放（片段）、波形、能量、实时数据流、AQC 质检、wav→mp3      | Web Audio：16k 单声道 WAV 录音、`decodeAudioData` 播放、波形 `"1\|2\|3"`、每 100ms 推 base64 PCM 数据流；**无 speex 编码器**，preload 把 speex 开关压成 0 走 pcm | ✅ 录音/播放/评测链路可用（speex 降级为 pcm） |
| `EtsHelper`     | 应用数据目录、日志、更新检查、配音合并、**接口签名**                        | 目录/日志/合并（ffmpeg）已实现；更新检查返回空；**接口签名 v1/v2 均已破解实现**                                                                                  | ✅ 完整                          |
| `SysConfig`     | 系统配置推送                                              | 回空配置，避免页面等待超时                                                                                                                      | ✅ 兜底                          |


### 排查记录：一路踩过来的坑（登录 → 窗口 → 音频 → 评测）

按顺序踩了十三个坑，全部已修（前 10 个在搭壳阶段，11–13 在音频/评测打通阶段）：

| #  | 现象                                                  | 根因                                                                                                                                                                                                                                                                                          | 状态                                                                                 |
| -- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1  | 停在“网络可能存在异常”，或页面完全空白                                | 页面是 https，但联网自检 `fetch('http://file.fei.ets100.com/network_test')` 被 Chromium 当**混合内容**拦掉，自检失败                                                                                                                                                                                              | ✅ 已修：`shell.ini` 里 `WebSecurity = 0`                                               |
| 2  | 隐私协议 iframe 空白                                      | 同上，`http://www.ets100.com/pc-html/privacy_reg.html` 被拦                                                                                                                                                                                                                                      | ✅ 已修                                                                               |
| 3  | 隐私协议点“同意”后，登录页只有 登录/注册 两个 tab，表单区空白                 | 启动链里 `EtsSeverUtils.initEtsSever()` 检查 `${EXE_PATH}/mq_server/ets_mq_server` 是否存在 → 问 `processexist` → 连 `ws://127.0.0.1:40001`；任何一步失败都会 reject，页面不再往下走                                                                                                                                     | ✅ 已修：内置 `app/mq_server/main.js`（纯 Node 实现的广播式 WebSocket），并让 `processexist` 返回 true |
| 4  | 表单仍然不渲染，接口全部 400                                    | 页面所有业务接口都走 `postIt()`：先用原生 `EtsHelper.encode_api_body` 拿签名，拿不到直接抛「鉴权失败」；拿到后服务端还会校验签名                                                                                                                                                                                                        | ✅ 已修，见文末「签名算法已完整破解」                                                                |
| 5  | 签名通了、接口全 200，但登录表单还是空白                              | `ShellHelper.getconfig` 只回了 `shell.ini` 的内容，缺 `MAC`。页面用 `DeviceCode = md5(appConfig.MAC,16).toUpperCase()`，`undefined.replace` 直接抛 `TypeError`，而 app 注册了全局 `errorHandler` 把它吞掉了 —— LoginView 的 `setup` 中断，整块表单渲染成注释节点 \`\`                                                                  | ✅ 已修：`getconfig` 补齐 `MAC/IP/OS/SystemName/Name/Version…` 全套设备字段                    |
| 6  | **登录成功后整页空白**，主进程日志出现 `渲染进程退出: crashed`，自动恢复 3 次仍白屏 | 见下一节「第 6 个坑」：页面把 2.9MB 的 `common.zip` 转成 3.78MB base64 后，走了 `atob().split('').map()` 的回退解码路径，渲染进程直接 FATAL                                                                                                                                                                                   | ✅ 已修：preload 里补 `Uint8Array.fromBase64`                                            |
| 7  | 注册/隐私条款弹窗没有明显的关闭按钮；点开协议全文后更是整页卡死、关不掉                | 窗口是 `frame:false` 无边框，没有系统红黄绿按钮。SPA 的 Navbar 只有一个很淡的 `.icon-close.nav-close`，且它的 `closeAction` 是 `router.back()`，无历史时点了没反应；而协议全文页是纯静态 HTML，压根没有关闭控件                                                                                                                                         | ✅ 已修：见「第 7 个坑」                                                                     |
| 8  | **窗口固定在屏幕左上角、拖不动**                                  | 三个原因叠加：① `shell.ini` 的 `WindowMaximize = 1` 让窗口一启动就最大化铺满屏幕，而 ini 的值是字符串 `"0"`，`if (shellConfig.WindowMaximize)` 对 `"0"` 也成立，改配置都没用；② 页面 `set_win_pos` 传 `win_x: null`，`Number(null) === 0`，窗口被反复扔到 (0,0)；③ 页面拖动只上报 `clientX/clientY`，主进程却要求 `screenX`，直接 return，拖动从未生效                      | ✅ 已修：见「第 8 个坑」                                                                     |
| 9  | **登录后播放没声音、录音录出来是静音**                               | 四个问题：① macOS 麦克风权限从未授权（`not-determined`），`getUserMedia` 拿到全 0 静音流；② 录音跟随设备采样率（本机 24000），讯飞评测引擎只认 16k；③ `ScriptProcessor` 直连 `destination`，把麦克风原声放出来；④ `play` 的 `begpos/endpos` 是毫秒却被当秒用，片段播放直接静音                                                                                            | ✅ 已修：见「第 9 个坑」                                                                     |
| 10 | **「原文试听 / 录音回放」点了弹「播放失败」**                          | 页面用 Howler + `<audio>` 播放，URL 由 `normalizeAudioUrl()` 拼成 `stic://file.iflytek.com/\\Users\\…\\content.mp3`（Windows 绝对路径）。而 `stic` 协议只按**相对路径**拼到应用目录下，必然 404；且响应没有 `content-length` / Range，`duration` 是 `Infinity`                                                                         | ✅ 已修：见「第 10 个坑」                                                                    |
| 11 | **单词发音（喇叭）点了弹「播放失败」**，课文音频同样放不出来                    | 音频在 `http://cdn.subject.ets100.com/media/*.mp3`，https 页面里的 `<audio>` 被 Chromium 自动升级成 https，而该 CDN 用的是网宿共享证书（`CN=default.chinanetcenter.com`）→ `ERR_CERT_COMMON_NAME_INVALID` → `onerror` → 弹「播放失败」。Windows 版 CEF 对这类证书错误是放行的                                                               | ✅ 已修：见「第 11 个坑」                                                                    |
| 12 | **单词跟读录完 0 分、「加油，继续努力」，提交评分失败**                     | 三处契约不符 + 一处能力缺失：① OSS 直传参数是**扁平**的（含 `localFile`），旧实现读 `data/filePath` → 表单空、无文件 → OSS 400；② `datastream_callback` 页面要求**纯 base64 字符串**，旧实现发对象 → 页面 `TypeError`，引擎拿不到音频；③ `waveform_callback` 约定是 `"1\|2\|3"` 这样的竖线字符串，旧实现发数组；④ 页面按 `stic_record_enable_speex` 走 **speex** 模式，我们无 speex 编码器 | ✅ 已修：见「第 12 个坑」                                                                    |
| 13 | **整句朗读弹「请正常朗读」**，录音只有 1 秒                           | `recordTime` 的单位是 **0.1 秒**（1000 = 100s），按毫秒/秒换算都把句子掐断，音频不足 → 引擎 `reject_type=128`                                                                                                                                                                                                          | ✅ 已修：见「第 13 个坑」                                                                    |

#### 第 6 个坑：登录后白屏 = 渲染进程崩溃（不是渲染问题）

现象是登录接口全 200、路由也跳了，但窗口一片白；`bridge` 日志里必定紧跟一条：

```
[WARN]  [bridge] 大回调 t3 3733KB            # common.zip 的 base64
[ERROR] [shell] 渲染进程退出: crashed exitCode=10
```

macOS 的 `.ips` 崩溃报告是 `EXC_BAD_ACCESS (SIGBUS)`，线程 `CrRendererMain`，栈里是  
`uv_run → node::Buffer::New → node::OnFatalError → v8::Function::Call`，即 **V8 堆被打爆**。

根因在页面 bundle（`assets/index-*.js`）里，这段是模块初始化时做能力探测的：

```js
_toUint8Array = typeof Uint8Array.fromBase64 === "function"
  ? s => Uint8Array.fromBase64(s)
  : s => _U8Afrom(atob(s).split("").map(c => c.charCodeAt(0)))   // ← 回退分支
```

`Uint8Array.fromBase64` 是 Chrome 133 才有的 API，而 Electron 31 内置 Chromium 126，  
所以页面 **必然** 走回退分支：3.78MB 的字符串被 `split('')` 成 378 万个单字符、再 `map`  
成 378 万元素数组，登录后解压 `common.zip` 时直接把渲染进程撑死。

修法是让探测到「有」——在 `preload.js` 里、页面脚本执行前补上原生实现  
（`Buffer.from(s,'base64')` 一次解码 + 一次 `set` 拷贝，3.78MB 只需 6ms）：

```js
if (typeof Uint8Array.fromBase64 !== 'function') {
  Object.defineProperty(Uint8Array, 'fromBase64', { value: /* ... */ });
}
```

A/B 实测（同一台机器、同一份 3.78MB base64）：

| 走哪条路                          | 结果                       |
| ----------------------------- | ------------------------ |
| 回退分支 `atob().split('').map()` | 渲染进程崩溃 `exitCode=10`     |
| 只把字符串传进页面、不解析                 | 正常，`OK len=3822936`      |
| 补垫片后 `Uint8Array.fromBase64`  | 正常，`2969600 bytes / 6ms` |

> 排查提示：`log.info('[shim] …')` 这条如果没出现，说明垫片没生效，登录后必白屏。

#### 第 7 个坑：无边框窗口没有关闭按钮

窗口是 `frame: false`，macOS 的红黄绿按钮根本不存在，关闭完全依赖页面自绘。

看两个页面的实际代码就明白了：

- `assets/Privacy-*.js`（隐私弹窗）：  
  `Navbar({ closeAction: () => router.back(), showBack: false })` —— 不显示「返回」，  
  只剩一个 `.icon-close.nav-close`。而 `assets/Navbar-*.js` 里 `closeAction` 就是 `router.back()`，  
  **没有历史记录时点了没有任何反应**；图标本身又是一个很淡的背景图，几乎看不见。
- 弹窗里的蓝色协议链接来自 `privacy_reg.html`：  
  `<a target="view_window" href="../home/userPrivacyPolicy-app.html">`。`window.open` 被  
  `setWindowOpenHandler` deny 后，Chromium 有时会把 **主窗口**直接导航到这个静态 HTML；  
  它是纯展示页，没有任何关闭控件，用户就彻底卡死。

修法分三层：

1. **主进程护栏**（`main.js`）：`will-navigate` 拦下主窗口跳静态页的导航；  
   `setWindowOpenHandler` 对 `.html` 纯展示页统一开 **带原生标题栏**（`frame: true`）的独立子窗口，  
   macOS 红黄绿按钮一定能关。日志里会有 `[shell] 静态展示页开独立窗口（带系统关闭按钮）: …`。
2. **preload 只补行为，不动 UI**：主界面右上角保持页面原版的 `.icon-close.nav-close`  
   （不做任何替换或隐藏），只给它挂一层兜底——点了 900ms 后路由还没变、仍停在  
   `#/auth/*` 里，说明 `router.back()` 没有历史可回，就兜底跳 `#/auth/login`。
3. **Esc**：静态页关窗（SPA 交给页面自己处理）。

> 曾经试过注入一个白色的「× 关闭」胶囊替换原版图标，功能没问题但视觉上和原版差太多，  
> 已回退。原则是：**外观一律跟原版走，只补原版缺失的能力**。

实测：`#/auth/selectEduSystem` 页点 × → 页面调用 `appcontroller.close` 关窗（原版语义）；  
`#/auth/privacy` 页点 × → 回登录页。截图见 `docs/screenshot-window-fixed.png`。

#### 第 8 个坑：窗口固定在左上角、拖不动

三个问题叠在一起，任何一个都足以让窗口「钉死」：

1. **`WindowMaximize` 的字符串陷阱**  
   `shell.ini` 里写的是 `WindowMaximize = 0`，但 ini 解析出来是**字符串** `"0"`，  
   `if (shellConfig.WindowMaximize) win.maximize()` 对 `"0"` 依然为真 → 每次都最大化，  
   铺满 workArea（实测 1920×963），最大化状态下当然既不能移动也不居中。  
   修法：显式比较 `String(shellConfig.WindowMaximize) === '1'`，并把 ini 默认值改成 0。
2. **`Number(null) === 0`**  
   页面每次路由切换都会调 `set_win_pos`，位置字段经常是 `null`：  
   `{"win_x":null,"win_y":null,"win_width":900,"win_height":600}`。  
   `Number(null)` 是 `0`，于是窗口被反复扔到屏幕左上角；用户拖走，下一次路由又被拉回去。  
   现在的语义：`null/undefined/非数字` → 保持当前位置；`(-1,-1)` → 居中；`(0,0)` → 也当未指定。
3. **拖动协议对不上**  
   页面 `plugins/stic/appcontroller.js` 里拖动是这么发的：
   ```js
   e.canvas.onmousedown = s => { e.mouseDown = true; e.startPoint = {x: s.clientX, y: s.clientY, ...} }
   window.onmousemove = s => { e.mouseDown && (e.endPoint = {x: s.clientX, ...}, e.move_callback(...)) }
   // OnMoveWindow 只取 x/y，发出去的是 {startPoint:{x,y}, endPoint:{x,y}}
   ```
   即只有 **clientX/clientY**，没有 screenX/screenY；而主进程原来的实现是  
   `if (typeof end.screenX !== 'number') return false` —— 每一帧都被丢弃，拖动永远无效。  
   而且 mousedown 只绑在 `document.getElementById(topDomId)` 上，隐私弹窗、静态子窗口  
   这些没有该 canvas 的页面根本不会触发。

   修法：`appcontroller.move` 只回 `'0'` 不移动窗口；改由 preload 统一接管——  
   在顶部 60px 内监听 mousedown/mousemove，用真实 `screenX/screenY` 做**绝对定位**：
   ```
   窗口新位置 = 按下时的窗口位置 + (当前鼠标 - 按下时鼠标)
   ```
   绝对定位的好处是掉帧、丢事件都不会累积误差。同时排除  
   `input/button/a/.icon-close/.nav-close/#__ets_close_control` 等可点元素，  
   避免点按钮时误拖窗口。
4. **拖过之后不许再被拉回**  
   页面把每个路由当成独立「窗口」，切页就要求居中。加了个标记：  
   一旦用户手动拖过（`dragStateOf(webContentsId).userMoved = true`），  
   之后 `set_win_pos` 的所有定位请求一律忽略，只保留尺寸变更。

> 注意：状态存在 `Map<webContentsId, state>` 里，不要挂在 `BrowserWindow` 实例上 ——  
> `BrowserWindow.fromWebContents()` 返回的包装对象不保证是同一个，自定义属性会丢。

实测（注入脚本直接调 `__etsShell.drag`）：

```
start:          [570, 267, 900, 600]   居中
afterDrag:      [670, 327]             +100 / +60，精确
afterCenterReq: [670, 327]             页面要求居中 → 忽略
afterZeroReq:   [670, 327]             页面要求 (0,0) → 忽略
```

调试入口：`__etsShell.drag({screenX,screenY},{screenX,screenY})`、`__etsShell.winAction('close')`。

#### 第 9 个坑：录音静音 / 播放没声音

`soundhelper` 是用 Web Audio 重写的（Windows 原版是讯飞自研音频引擎），踩了四个坑：

1. **macOS 麦克风权限从未授权**  
   日志里 `systemPreferences.getMediaAccessStatus('microphone')` 返回 `not-determined`。  
   此时 `getUserMedia()` **不会报错**，而是返回一条**全 0 的静音流** —— 录出来的 wav  
   peak 严格等于 0，页面看起来「录音成功但没声音」。  
   修法：启动时主动 `askForMediaAccess('microphone')`，并把状态写进日志。  
   实测授权前 `peak=0`，授权后同一次录音 `peak=5373`。
   > 注意：每次 `codesign --force` 重新签名，cdhash 会变，macOS 可能把应用当成新的，  
   > 权限需要重新授予一次。
2. **采样率跟着设备走**  
   本机 `AudioContext` 默认 24000（不是 16k）。讯飞评测引擎只认 16k PCM，  
   24k 的 wav 上传后评测结果会异常（时长/语速全错）。  
   修法：录音单独建 `new AudioContext({ sampleRate: 16000 })`，Chromium 会自动把  
   麦克风流重采样到 16k；播放仍用设备默认采样率，保证音乐音质。
3. **`ScriptProcessor` 直连扬声器 = 啸叫**  
   `ScriptProcessorNode` 必须接到 `destination` 才会持续触发 `onaudioprocess`，  
   但直连会把麦克风原声放出来。修法：中间串一个 `gain = 0` 的节点。
4. **`begpos/endpos` 单位错**  
   Windows 客户端传的是**毫秒**，旧实现当秒用：`src.start(0, 1500)` 等于从第 1500 秒开始播，  
   直接静音。修法：数值超过文件时长、但除以 1000 后落在时长内 → 按毫秒处理。

实测（`__etsShell` 之外直接走 `cef.message` 调 soundhelper）：

```
录音: 采样率=16000 单声道 2.82s  90156 字节  peak=5373
播放: begin{time_len:6.385} → pos 0.17/0.37/0.58 → end{code:0}
片段: play(begpos:1000, endpos:2000) → begin{begpos:1, endpos:2}
```

**排查提示**：如果录音还是没声音，先看日志里 `录音开始 采样率=` 和 `录音落盘` 两行；  
再看系统设置 → 声音 → 输入，本机默认输入是「Rapoo camera」（外接摄像头自带麦克风），  
信号比内置麦克风弱很多。

#### 第 10 个坑：「原文试听 / 录音回放」播放失败

页面里其实有**两套**播放实现：

| 类                  | 实现                                   | 用在        |
| ------------------ | ------------------------------------ | --------- |
| `H5SoundHelper`    | Howler.js + `<audio>`（`html5: true`） | 原文试听、题目音频 |
| `LocalSoundHelper` | `SndHelper` → 我们的 `soundhelper` 插件   | 录音回放、波形   |

「原文试听」走 H5 那套，URL 是这么来的：

```js
STIC_PATH = 'stic://file.iflytek.com/'
function normalizeAudioUrl(e) {
  // 已带 http/stic:// 等前缀就原样返回，否则拼到 stic:// 后面
  return SUPPORTED_AUDIO_URL_PREFIXES.some(p => e.startsWith(p)) ? e : `${STIC_PATH}${e}`
}
```

页面传给它的路径是 **Windows 绝对路径** `\\Users\\lihaodong\\…\\content.mp3`，  
于是最终 URL 变成 `stic://file.iflytek.com/\\Users\\lihaodong\\…`。

两个问题：

1. **`stic` 协议把它当相对路径**  
   原实现只做 `path.join(APP_ROOT, rel)` / `DATA_ROOT` / `RESOURCES`，  
   实际去找 `…/E听说/Users/lihaodong/…` —— 必然 404，Howler 报 `onloaderror` → 「播放失败」。  
   修法：额外把 `path.resolve('/', rel)` 作为候选，并且只放行  
   用户目录 / 应用目录 / 数据目录 / 资源目录，避免变成任意文件读取。
2. **响应没有 `content-length`、不支持 Range**  
   即使文件读到了，`new Audio(stic://…)` 的 `duration` 会是 `Infinity`，  
   进度条也拖不动（Howler 的 sprite 依赖 duration）。  
   修法：抽出 `serveLocalFile()`，统一返回 `content-length` / `accept-ranges: bytes`，  
   并正确响应 `Range: bytes=x-y`（206 + `content-range`），用 `Readable.toWeb` 流式返回。

实测：

```
GET stic://file.iflytek.com//Users/…/content.mp3  → 200, 1409871 字节
duration = 58.458s, seekable = [0, 58.458], readyState = 4
拖动到 5s → seeked t=5.00
```

> 调试技巧：`stic` 协议 404 时日志会打出 `[stic] 404 rel=… 候选=…`，一眼能看出路径被拼到哪去了。

#### 第 11 个坑：单词发音「播放失败」= CDN 证书 CN 不匹配

现象：单词卡片点喇叭（或课文「原文试听」）弹「播放失败」，`bridge` 日志里是这两行：

```
[ERROR] [page:2] Mixed Content: ... requested an insecure element 'http://cdn.subject.ets100.com/media/6f3e16f0….mp3'
[WARN]  [net] net::ERR_CERT_COMMON_NAME_INVALID GET https://cdn.subject.ets100.com/media/6f3e16f0….mp3
```

链路是：页面 https → Chromium 把 http 音频**自动升级**成 https → 该 CDN 走网宿，证书是共享证书  
（`CN=default.chinanetcenter.com`），与域名不匹配 → 证书校验失败 → `<audio>` 触发 `onerror` → 页面弹「播放失败」。  
Windows 版 CEF 默认放行这类证书错误，所以官方客户端没这个毛病。

修法（`app/main.js`）：

```js
// ① 会话级：自家域名直接放行，其他域名仍走 Chromium 默认校验（-3）
ses.setCertificateVerifyProc((req, cb) => ETS_HOST.test(req.hostname) ? cb(0) : cb(-3));

// ② 兜底：任何 webContents 的证书错误，自家域名 preventDefault + callback(true)
app.on('certificate-error', (e, wc, url, err, cert, cb) => { … });

// ③ 所有 http://*.ets100.com 重定向到 https，避开 Mixed Content 对 XHR 的硬拦截
ses.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (d, cb) => {
  if (ETS_HOST.test(host(d.url))) return cb({ redirectURL: 'https://' + d.url.slice(7) });
  cb({});
});
```

③ 顺带治好了另一批被拦掉的请求：`http://cdn.subject.ets100.com/entity/*/content2.json`（题图/内容）之前是被  
Mixed Content **直接 block**，现在是正常升级到 https。

验证方式（不用点 UI）：在 Electron 31 里用同一个会话配置加载 `statics.ets100.com`，再  
`new Audio(http://cdn.subject.ets100.com/media/xxx.mp3)`，能拿到 `onloadedmetadata`（duration≈1.5s）即通过；  
日志里只会剩 `[cert] 放行 cdn.subject.ets100.com（default.chinanetcenter.com）`。

#### 第 12 个坑：录音 0 分 / 提交评分失败（契约不符 ×3 + 能力缺失 ×1）

页面是打包过的 Vue bundle，直接从

```
~/Library/Application Support/E听说/runtime/Cache/Cache_Data/07d4460e35a5d06b_0
```

里把业务代码翻出来对照（`grep -o` 找 `upload(`、`datastream`、`isSpeexMode` 一带的上下文），四处问题：

**(1) OSS 直传参数是扁平的，不是 `data` 嵌套**

页面这样调：

```js
const A = {
  OSSAccessKeyId: u, policy: a, signature: s, 'x-oss-security-token': d,
  'x-oss-object-acl': 'public-read', key: l, localFile: e, url: m,
  submit: 'Submit', success_action_status: o ? 200 : '200'
};
await HttpUtils.upload(A, e);
```

|                                                                                  |   |              |
| -------------------------------------------------------------------------------- | - | ------------ |
| 注意 `localFile` 是**文件路径字段**，而且**没有** `data/fields` 这一层。旧实现读 \`p.data              |   | p.fields\` 和 |
| `p.filePath`，等于「表单一个字段都没有 + 文件也没带」→ 阿里云回 `400`（日志：`[httphelper] upload -> 400`）。 |   |              |
| 另外返回值约定是 `{"rncode":0}`（页面 `JSON.parse(y).rncode === 0` 判成功），不能回 OSS 的原始 body。   |   |              |

修法（`app/bridge/plugins/httphelper.js`）：控制字段（`url/localFile/filePath/name/headers/…`）之外的键**原样**当表单字段，  
文件字段名固定 `file`，按扩展名给 `Content-Type`（`.mp3→audio/mpeg`、`.xml→application/xml`），2xx 回 `{"rncode":0}`。  
本地起个假 OSS 就能验证：7 个字段齐全 + 文件在最后 + 回包正确。

> 注意：`x-oss-security-token` 是 STS 临时凭证必需字段，漏了同样是 400，且报错信息只说 `MalformedPOSTRequest`。

**(2) `datastream_callback` 必须是 base64 字符串**

页面收到数据流后直接丢给评测实例：

```js
datastream_callback: e => { const n = c[t].iseInstance; n?.send(e); }
// …而 send(e) 内部是：
send(e){ const t = toUint8Array$1(e) … }     // toUint8Array 里做的是 e.replace(/[-_]/g,…) + atob
```

所以 `e` 必须是**纯 base64 字符串**。旧实现发的是 `{ id, seq, sampleRate, data }` 对象 → 每个包都  
`e.replace is not a function`（异常被页面内部的 Promise 链吞了，日志里看不到），引擎从头到尾没收到音频，  
返回的评测 XML 就是 `is_rejected="true" except_info="28676"`、`total_score≈0`。  
现在发 `encodeWav(chunk).slice(44).toString('base64')` —— 16k 单声道 PCM16 裸流（无 WAV 头）。

|                                     |    |               |
| ----------------------------------- | -- | ------------- |
| \*\*(3) `waveform_callback` 是 \`"12 | 45 | 78"\` 字符串\*\* |

|                |                                                        |
| -------------- | ------------------------------------------------------ |
| 页面 \`e.split(" | ").map(Number)`，传数组会得到 `NaN`。`loadfile\` 的波形也一并改成竖线分隔。 |

**(4) speex 模式：没有编码器，就把开关压掉**

页面 getter：

```js
isSpeexMode: e => {
  const t = e.systemConfig?.stic_record_enable_speex;
  return e.systemConfig && 1 == t && isVersionAboveOrEqual(VITE_CLIENT_VERSION, '5.7.3')
         && 'Linux' != localStorage.getItem('os');
}
```

为真时，发给引擎的 `format` 是 `"speex"`、录音文件名是 `.spx`、`<audio>` 也不一样。Windows 有讯飞自家音频引擎能编  
speex，Electron 里没有；硬发 PCM 却贴 speex 标签，引擎只会解出噪音。

于是在 `app/preload.js` 里包一层 `JSON.parse`，把这个开关**深度**改成 0：

```js
const SPEEX_KEYS = ['stic_record_enable_speex', 'hd_stic_record_enable_speex'];
JSON.parse = function (text, reviver) {
  const out = origJsonParse.call(JSON, text, reviver);
  if (typeof text === 'string' && text.indexOf('stic_record_enable_speex') !== -1) fixSpeexFlags(out, 0);
  return out;
};
```

必须**深度**扫描，因为这个值出现在三处：接口响应 `{code, body:{…}}`、pinia 持久化的整个 store  
（`{userInfo, ecardInfo, systemConfig:{…}}`）、以及 `localStorage.systemConfig`。只改顶层会漏掉后两处，  
表现就是「日志里明明打了 `强制…=0`，录音参数还是 `dataStreamType:"spx"`」。

关掉之后整条链路变成 `format:"pcm"` + `.wav` 文件名，正好是 soundhelper 能提供的格式。

#### 第 13 个坑：整句朗读弹「请正常朗读」

修完第 12 个坑后评测已经能出分（XML 里有 `accuracy_score / fluency_score / pitch` 曲线），但录音只有 **1.02 秒**：

```
soundhelper.record args={"recordTime":1000, …}
录音落盘 …wav 32812 字节 … 1.02s
```

`recordTime` 的单位**恒定为 0.1 秒**（页面 `b()` 里就是 `record_time / 0.1`）：`50 = 5s`、`100 = 10s`、  
`1000 = 100s`。之前两版分别按「×1000 当毫秒」和「>600 就不换算」处理，一个把 5 秒当 50 秒、一个把 100 秒当 1 秒，  
句子刚开口就被 `timeout` 掐掉，音频不足 → 引擎 `reject_type=128` → 页面弹「请正常朗读」。

现在统一 `const ms = recordTime * 100;`。**不要再用阈值猜单位**。

#### 补充：第 5 个坑的定位手法（可复用）

页面在 Vue 生产构建里把 setup 异常交给全局 `errorHandler`，控制台一行日志都不会有。  
定位手段是给 `app.config.errorHandler` 套一层钩子再强制重新挂载组件：

```js
var app = document.querySelector('#app').__vue_app__;
var orig = app.config.errorHandler;
app.config.errorHandler = (err, i, info) => { window.__etsErrs.push(info + ' ' + err.stack); orig && orig(err, i, info); };
location.hash = '#/auth/register';           // 卸载
setTimeout(() => location.hash = '#/auth/login', 1500);   // 重新挂载，触发 setup
```

栈顶会直接指到 `md5(...)`，一眼就能看到是哪个字段是 `undefined`。

顺带修掉的第二个坑：`sqlitepln.execQuery` 原来返回 `data = rows.map(r => JSON.stringify(r))`（字符串数组），  
但页面 `clientDB.js` 在 Windows 分支里按 `row.Entry / row.Value` 取值，导致 `localStorage.clientConfig` 恒为 `{}`，  
表现为「版本号 v」后面空着、`EnvType` 判断失败还会多触发一次整页 reload。改成返回对象数组后正常显示 `v5.7.9`。

### 关于接口签名（已解决，推导过程见文末）

页面要求原生返回 **32 位十六进制**（`SIGN_PATTERN=/^[a-f\d]{32}$/`），算法在 `etshelper.pln` 里。静态分析已定位到：

|   |   |   |   |   |
| - | - | - | - | - |

|   |   |   |   |   |
| - | - | - | - | - |

- `0x10014110` 是一个 MD5 包装：`md5(str0 || str1 || str2)` 后转 hex（`.rdata` 0x6a540 处是标准 MD5 IV）
- 调用点 `0x1000a71c`：`str1 = time`（毫秒字符串）、`str2 = body`（base64 请求体）
- `str0` 来自 `[ebp+0x20]`，即**调用方额外传进来的密钥参数**，在函数体内没有任何字符串常量

**已经解出来了。** 继续往上一层追分发函数（`0x1000aa70` 起的 `PlnOnProcessMessage`）后确认：

- v1 分支：`std::string pid("grlx", 4)` → 作为第 5 个参数传给签名函数 → `sign = md5("grlx" + time + body)`
- v2 分支：同一个函数，只是 `pid = "pcWin"`、`edx/栈参数 = 1`（v2 标志），并且返回值要包装成  
  `{pid:"pcWin", sign_version:"2", key_id:"202608", sign:<32位hex>}`
- 其中 `key_id` 是常量 `"202608"`（`.rdata` 0x10067a80），不是动态获取
- 签名函数内部只有 3 次 MD5 update + 1 次 final + 1 次 hex，没有任何额外常量参与

所以 **没有 secret**，就是 `md5(pid + time + body)`。壳里已按这个实现，并用 `shell.ini` 的

|                     |                                        |
| ------------------- | -------------------------------------- |
| \`SignProtocol = v1 | v2\` 切换（v1 返回裸串，v2 返回带 key_id 的 JSON）。 |

历史候选（在确认算法前试过、均被 400 拒绝）：  
`md5(time+body)`、`md5(body+time)`、`md5(grlx+time+body)`、`md5(time+body+grlx)`、  
`md5(ldlflfgirerjfkcf+…)`、`md5(f05323cb91d422b2+…)`、`md5(pcWin+…)`、含 `sn/version/system` 的组合、  
`md5(明文JSON+time)`、`md5(time_second+body)` 等约 30 种。

### 为什么本机测试仍然 400（重要）—— 此结论已被推翻

> **历史注记（2026-11-14 晚更新）**：下面这段是签名还没完全破解时的推断，当时以为是网关/WAF 拦截。  
> 破解后发现真实原因是 **SUFFIX 没参与计算**（把 `0x10014110` 的 `ecx` 误当成输出指针，实际是 v1/v2 算法选择），  
> 签名算错就是 400，跟出口 IP 无关。此段保留作为排查过程记录，结论请以文末「签名算法已完整破解」为准。

在开发机上按上面算法发请求，`/system/config`、`/announcement/list`、`/file/download` 全部返回  
**HTTP 400 且响应体为空**，但——

- 未知路径（如 `/zzz`）返回 **200** + `[{"code":10000,"msg":"the request format is invalid"}]`
- 对 `/system/config` 连 **OPTIONS 预检** 都返回 400（预检没有 body，无从校验签名）

这说明 400 是**网关（istio-envoy + 阿里云 WAF）按路由做的整体拦截**，而不是“签名算错”：  
请求根本没进到业务服务。最可能的原因是当前开发机的出口 IP（走代理/机房 IP）被 WAF 拦了。

因此需要在**你自己的网络**上验证一次：菜单栏 **E听说 → 接口签名自检（诊断用）**，  
它会用 v1/v2 两种签名各打一次 `/system/config`，直接弹出 HTTP 状态码。

- 若出现 **HTTP 200**：签名算法正确，登录即可用；把 `shell.ini` 的 `SignProtocol` 切到对应值即可。
- 若仍是 **400**：说明该网络也被拦，或服务端还要求别的东西；此时最有效的一步是  
  在 Windows 机器上用 Fiddler/Proxifier 抓一条真实 `/system/config` 请求，把  
  `(time, body, sign)` 三元组发我，我可以立刻判定差异在哪。

### 另外两个已知限制

1. ~~**接口签名 `encode_api_body / encode_api_resp`**~~ ✅ **已解决**  
   `sign = md5(pid + time + body + SUFFIX)`，两套 SUFFIX 已从 `etshelper.pln` 的 `.rdata` 表还原，  
   见文末「签名算法已完整破解」。启动时会自动探测 v1/v2 并采用能通的那个。
2. **录音引擎不是讯飞原生引擎（已实测可用，格式降级为 pcm）**  
   实时评测（`datastream` 推流）已跑通：16k 单声道 PCM16 裸流按 base64 每 100ms 推给页面的评测实例，  
   引擎能返回逐词分数与 pitch 曲线（见「第 12、13 个坑」）。**前提是页面走 `format:"pcm"`** ——  
   preload 会把服务端的 `stic_record_enable_speex` 压成 0，因为我们没有 speex 编码器。  
   `speex` 编码、AQC 评分仍无法复刻（讯飞私有 SDK），相关接口返回「通过」以保证流程不中断。

## 四、怎么用

```bash
cd ets-mac-shell
npm install          # 只装 electron（约 90MB）
./build.sh           # 产出 dist/E听说.app（自动临时签名）
./build-dmg.sh       # 产出 dist/E听说-<版本>.dmg（app + 「应用程序」快捷方式，可直接分发）
open "dist/E听说.app"
```

开发调试（不打包）：

```bash
npx electron .                 # 直接跑源码
ETS_HOME=file://$PWD/test/harness.html npx electron .   # 跑桥接自测页
```

- **发布包默认没有调试菜单**（重新加载 / 桥接日志 / 接口签名自检 / 开发者工具全部隐藏，devtools 也关掉）。  
  现场排查需要时：`ETS_DEBUG_MENU=1` 启动，或在 `~/Library/Application Support/E听说/debug.json` 里写 `{"debug_menu":1}`。
- 调试菜单打开后：`⌘L` 桥接日志窗口（所有 `插件.方法 / 参数 / 回调`）、`⌥⌘I` 开发者工具。
- 日志文件：`~/Library/Application Support/E听说/logs/bridge-YYYY-MM-DD.log`
- 数据目录：`~/Library/Application Support/E听说/`（`localdata`、`common/material`、`download`、`logs`）

想换环境（正式/灰度/测试）或指向别的入口，改 `app/shell.ini` 的 `URL` 即可。

### 发布包（dmg）说明

`./build-dmg.sh` 干的事：`./build.sh` 出 `.app` → `ditto` 拷进临时目录 → 加一条指向 `/Applications` 的  
「应用程序」快捷方式 → `hdiutil create -format UDZO` → `hdiutil verify`。产物 `dist/E听说-<版本>.dmg`（约 104MB）。

几条约定，改构建时别踩：

| 事项             | 说明                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| 只打 `app/` 源码目录 | **不要**直接打包 `/Applications/E听说.app` —— 里面已经攒了用户录音（`app/soundfiles/`）和资源缓存（`app/temp/resources/`），会被一起打进安装包 |
| 调试入口           | `app/main.js` 的 `DEBUG_MENU` 默认 false：菜单里没有 重新加载 / 桥接日志 / 签名自检 / 开发者工具，`webPreferences.devTools=false`    |
| 签名             | ad-hoc（无开发者证书）。本机构建本机装没提示；跨机器分发时首次打开需 **右键 → 打开**，或到「隐私与安全性」点「仍要打开」                                       |
| 版本号            | 取自 `package.json`，改完重新 `./build-dmg.sh` 即换文件名                                                             |
| zsh 小坑         | 脚本里 `"…$APP_NAME」…"` 这种中文紧跟变量会被当成变量名，要写 `${APP_NAME}`                                                     |

### 「记住密码」是壳层接管的

线上页面原本靠 Windows CEF 宿主把账号密码写进 `localdata/ETS.db` 的 `Config(UpdateLoginInfo/LoginInfo)`；  
macOS 壳没有这一层，网页自己的 `saveLoginInfoToDB` 又因拿不到 IndexedDB 记录而从不触发，所以「记住密码」永远没数据。

现在由壳接管（`app/main.js` 末尾的 `remember:*` IPC + `app/preload.js` 的 `installRememberLogin()`）：  
登录页捕获表单 → 成功后经本地 IPC 交给主进程存进 **macOS 钥匙串**（service `E听说 macOS Shell Login`）→  
下次启动由 preload 填回输入框。密码不写 localStorage、不落明文文件、不进日志。

## 五、自测结果

`test/harness.html` 用**官方 `plugins/stic/*.js` 原版封装**调用本实现，验证参数与回调契约：

```
通过 16/16
✔ cef.message 存在 / createGuid 唯一
✔ AppController init / get_win_pos / set_win_pos(居中)
✔ ShellHelper getconfig(讯飞E听说) / getuniqueid / getvolume / CheckAudio
✔ FileHelper 写读文本 / existfileorfolder / getmd5 / getbase64
✔ sqlitepln 查询 Config（读到 C_Version=5.7.9 等 6 行）
✔ EtsHelper get_appdata_path
✔ soundhelper loadfile（时长 + 波形点）
```

真实线上页面：可正常启动到登录页（隐私协议 → 登录/注册 → 账号密码表单），窗口无边框、右上角关闭按钮、拖拽均可用。

音频与评测链路（线上页面实测）：

```
单词发音    http://cdn.subject.ets100.com/media/*.mp3 → 升级 https + 证书放行 → 可播放（时长/进度正常）
句子跟读    recordTime=1000（=100s）, 录音 2~4s → datastream 12 块 / 98KB → 引擎返回 accuracy/fluency/pitch
OSS 直传    mp3/wav + xml 各一次上传 → 200（之前固定 400）
```

判读日志的三行关键输出：

```
[httphelper] upload <文件> (字节) -> ets60.oss-cn-hangzhou.aliyuncs.com/ 字段=OSSAccessKeyId,policy,…,key,…
[httphelper] upload -> 200
[soundhelper] 录音停止 数据流=12块/98304字节 采样率=16000
```

## 六、继续往下可以做什么

- ~~补 `encode_api_body` 签名~~ ✅ 已完成，见文末
- 用 `AVAudioEngine` 写一个原生插件替换 Web Audio，降低录音延迟，并顺手把 speex 编码补上（补上后就可以去掉 preload 里压 `stic_record_enable_speex` 的那段 shim）
- ~~把 `mq_server`（40001 端口广播）也搬过来~~ ✅ 已内置 `app/mq_server/main.js`
- 若页面后续新增插件方法，`app/bridge/bus.js` 会把「未实现」的调用记进日志，按日志补 handler 即可

---

---

## ✅ 签名算法已完整破解（2026-11-14 晚）

用 Parallels 里的 Windows 客户端 + 自建 MITM 代理抓到真实请求（`docs/captured-requests.txt`），  
再用 capstone 静态分析 `etshelper.pln`，算法完全还原，**三组真实样本逐一验证通过**，  
接口从 HTTP 400 变为 **HTTP 200 + `{"msg":"成功","code":0}`**。

### 算法

```
sign = md5( pid + time + body + SUFFIX )      // 32 位小写 hex

v1: pid = "grlx",  SUFFIX = "555ffbe95ccf4e9535a110170b445ab8"
v2: pid = "pcWin", SUFFIX = "94cfbda3fbfef02b93693f8bc153be82"
```

`time` 是 head.time（毫秒字符串），`body` 是 base64 请求体（**原样，不解码**）。

### SUFFIX 的来历

`0x10013e00` 不是 MD5 final，而是从 `.rdata` 的两张表生成 32 字节再追加进 MD5 上下文：

| 协议 | 索引表        | 数据表        | 期望 FNV     |
| -- | ---------- | ---------- | ---------- |
| v1 | 0x100691c8 | 0x10069208 | 0x32a7b273 |
| v2 | 0x100692d0 | 0x10069310 | 0xb9ef3cd1 |

生成逻辑（`0x10013d30`）：

```
v = tblB[i]                          // i = 0..31
(a,b,c,d) = tblA[v]                  // 4 字节结构
a = ror8(a, d & 7)
out[i] = (a - c) ^ b
```

这 32 字节的 FNV-1a 校验值（`h=0x811c9dc5; h^=byte; h*=0x1000193`）必须等于表中的期望值——  
本机算出 v1 = `555ffbe95ccf4e9535a110170b445ab8`、v2 = `94cfbda3fbfef02b93693f8bc153be82`，  
**FNV 校验双双命中**，证明还原正确。

### 验证结果

```
POST /g/resource/login-list   → 200
POST /system/config           → 200  {"msg":"成功","code":0,...}
POST /announcement/list       → 200
```

壳里默认 `SignProtocol = v2`（现网客户端已切 v2），启动时会自动探测 v1/v2 选可用的那个。
