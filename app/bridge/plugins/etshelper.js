'use strict';
/**
 * EtsHelper 插件（应用数据目录 / 日志 / 更新 / 接口签名）
 * 对应 Windows: plugins/etshelper/etshelper.pln
 *
 * 重点说明：
 *  - get_appdata_path 是页面拼资源路径的根目录，必须返回一个真实可写目录。
 *  - encode_api_body / encode_api_resp 是 Windows 端用原生密钥做的接口签名。
 *    macOS 壳没有对应密钥，这里返回空串，页面会走「不签名」分支继续请求
 *    （页面代码里对空返回值做了兜底，不会崩）。
 *  - check_update 返回空对象，表示不检查更新（macOS 版不接入 Windows 升级包）。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

/**
 * 接口签名（完整逆向自 etshelper.pln 的 OnEncodeAPIBody）
 *
 * 算法 = md5( pid + time + body + SUFFIX )，32 位小写十六进制
 *   v1: pid = "grlx",  SUFFIX = "555ffbe95ccf4e9535a110170b445ab8"
 *   v2: pid = "pcWin", SUFFIX = "94cfbda3fbfef02b93693f8bc153be82"
 *
 * SUFFIX 的来源：0x10013e00 用 .rdata 里两张表（0x100691c8/0x10069208 为 v1，
 * 0x100692d0/0x10069310 为 v2）生成 32 字节，再追加进 MD5 上下文。
 * 生成逻辑：v=tblB[i]; (a,b,c,d)=tblA[v]; a=ror8(a,d&7); out[i]=(a-c)^b
 * 校验：这 32 字节的 FNV-1a 分别等于 0x32a7b273(v1) / 0xb9ef3cd1(v2)。
 */
const SIGN_SUFFIX = {
  v1: '555ffbe95ccf4e9535a110170b445ab8',
  v2: '94cfbda3fbfef02b93693f8bc153be82'
};
const SIGN_PID = { v1: 'grlx', v2: 'pcWin' };

function md5hex(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function pick(p, keys) {
  for (const k of keys) if (p && p[k] !== undefined && p[k] !== null) return String(p[k]);
  return '';
}

function signPayload(p, protocol) {
  const proto = protocol === 'v1' ? 'v1' : 'v2';
  const body = pick(p, ['body', 'data']);
  const time = pick(p, ['time', 'timestamp']);
  return md5hex(SIGN_PID[proto] + time + body + SIGN_SUFFIX[proto]);
}

/** 由 shell.ini 的 SignProtocol 决定返回 v1 的裸串还是 v2 的 JSON */
function currentProtocol(ctx) {
  const v = String((ctx && ctx.shellConfig && ctx.shellConfig.SignProtocol) || 'v2').toLowerCase();
  return v === 'v2' ? 'v2' : 'v1';
}

module.exports = {
  init(api) { api.respond('0'); },

  get_appdata_path(api) { api.respond(api.ctx.paths.dataRoot); },

  /** 页面自己的日志上报，落到本地文件 */
  log_data(api) {
    const p = api.payload || {};
    const text = typeof p === 'string' ? p : (p.log || p.data || JSON.stringify(p));
    const file = path.join(api.ctx.paths.logRoot, 'web.log');
    fsp.mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.appendFile(file, `[${new Date().toISOString()}] ${text}\n`))
      .then(() => api.respond('0'))
      .catch(() => api.respond('0'));
  },

  check_update(api) { api.respond({}); },
  check_update_force(api) { api.respond({}); },
  run_update(api) { api.respond('0'); },
  test_crash(api) { api.respond('0'); },

  /** 用默认浏览器打开链接（支付、帮助页等） */
  open_url_by_def_browser(api) {
    const p = api.payload || {};
    const url = p.url || p.URL || '';
    api.ctx.openExternal(url);
    api.respond('0');
  },

  /** 配音合并：有 ffmpeg 就合，没有就返回第一段 */
  dub_merge(api) {
    const p = api.payload || {};
    const list = (p.audio_list || p.files || []).map((x) => api.ctx.resolve(x));
    const dst = api.ctx.resolve(p.outPath || p.destPath || p.filePath || './localdata/dub_merge.mp3');
    const ff = api.ctx.paths.ffmpeg;
    const hasFf = ff && fs.existsSync(ff);
    if (!hasFf || list.length === 0) {
      fsp.mkdir(path.dirname(dst), { recursive: true })
        .then(() => (list[0] ? fsp.copyFile(list[0], dst) : Promise.resolve()))
        .then(() => api.respond({ code: 0, filePath: dst }))
        .catch(() => api.respond({ code: -1 }));
      return;
    }
    const inputs = [];
    list.forEach((f) => inputs.push('-i', f));
    const filter = `${list.map((_, i) => `[${i}:a]`).join('')}concat=n=${list.length}:v=0:a=1[out]`;
    fsp.mkdir(path.dirname(dst), { recursive: true })
      .then(() => new Promise((resolve, reject) => {
        execFile(ff, ['-y', ...inputs, '-filter_complex', filter, '-map', '[out]', dst],
          { timeout: 180000 }, (err) => (err ? reject(err) : resolve()));
      }))
      .then(() => api.respond({ code: 0, filePath: dst }))
      .catch((e) => api.respond({ code: -1, msg: e.message }));
  },

  /**
   * 接口签名：页面要求返回 32 位十六进制串（SIGN_PATTERN=/^[a-f\d]{32}$/）。
   * 原生算法在 etshelder.pln 里（内嵌 MD5，密钥未知），这里先用 md5(body+time) 占位，
   * 目的是让页面不再抛「鉴权失败」，便于继续联调；服务端是否认可需实测。
   */
  encode_api_body(api) {
    if (currentProtocol(api.ctx) === 'v2') {
      // 让页面直接走 v2：返回带 key_id 的 JSON
      api.respond({
        pid: 'pcWin',
        sign_version: '2',
        key_id: '202608',
        sign: signPayload(api.payload, 'v2')
      });
      return;
    }
    api.respond(signPayload(api.payload, 'v1'));
  },
  encode_api_resp(api) { api.respond(signPayload(api.payload, 'v1')); },
  encode_api_body_v2(api) {
    // 页面会先试 v2；只有配置成 v2 时才应答，否则回空让页面回退到 v1
    if (currentProtocol(api.ctx) !== 'v2') { api.respond(''); return; }
    api.respond({
      pid: 'pcWin',
      sign_version: '2',
      key_id: '202608',
      sign: signPayload(api.payload, 'v2')
    });
  },
  encode_api_resp_v2(api) {
    if (currentProtocol(api.ctx) !== 'v2') { api.respond(''); return; }
    api.respond({ pid: 'pcWin', sign_version: '2', key_id: '202608', sign: signPayload(api.payload, 'v2') });
  }
};
