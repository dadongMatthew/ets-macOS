'use strict';
/**
 * ShellHelper 插件（外壳信息 / 系统能力）
 * 对应 Windows: plugins/shellhelper/shellhelper.pln
 *
 * 页面主要用到：getconfig（读 shell.ini）、getpcinfo、getuniqueid、
 * 音量控制、CheckAudio、netcheck、getsysytemlocalpath、clipboard。
 * Windows 专有的授权/进程/设备相关接口在这里做“安全降级”，返回可解析的空值，
 * 避免页面卡在 3 秒超时上。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { machineId } = require('../util');

function osascript(script) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 4000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim());
    });
  });
}

/** 按优先级遍历网卡：先物理口，再虚拟口，跳过回环与全零 MAC */
function eachNic(cb) {
  const ifaces = os.networkInterfaces();
  const prefer = ['en0', 'en1', 'en2', 'bridge0'];
  const names = prefer.filter((n) => ifaces[n]).concat(Object.keys(ifaces).filter((n) => prefer.indexOf(n) < 0));
  for (const name of names) {
    for (const it of ifaces[name] || []) {
      const r = cb(it, name);
      if (r) return r;
    }
  }
  return '';
}

/**
 * 本机 MAC（Windows 壳里是 AA-BB-CC-DD-EE-FF 这种带横杠的大写形式）。
 * 页面用它算 DeviceCode = md5(MAC, 16).toUpperCase()，缺了这个值会让登录组件
 * 的 setup 抛 TypeError，整块登录表单渲染成注释节点（白屏）。
 */
function primaryMac() {
  const mac = eachNic((it) => {
    if (it.internal) return '';
    if (!it.mac || it.mac === '00:00:00:00:00:00') return '';
    return it.mac.toUpperCase().replace(/:/g, '-');
  });
  if (mac) return mac;
  // 兜底：用机器码派生，保证同一台机器每次都一样
  const hex = crypto.createHash('md5').update(machineId()).digest('hex').slice(0, 12).toUpperCase();
  return hex.match(/.{2}/g).join('-');
}

/** 本机内网 IPv4 */
function primaryIp() {
  const ip = eachNic((it) => {
    if (it.internal || it.family !== 'IPv4') return '';
    if (!it.address || it.address.startsWith('169.254.')) return '';
    return it.address;
  });
  return ip || '127.0.0.1';
}

/** 页面 appConfig store 的默认字段（少一个都可能被直接读取后抛错） */
function deviceConfig(base) {
  const spoof = String(base.SpoofOS || '').toLowerCase();
  const osName = spoof === 'windows' ? 'Windows 10' : `macOS ${os.release()}`;
  const defaults = {
    Address: '',
    AppTitle: base.AppTitle || '讯飞E听说',
    ClientType: 'PC',
    CopyRight: '',
    FullScreen: String(base.FullScreen != null ? base.FullScreen : 0),
    HDSerial: machineId().replace(/-/g, '').slice(0, 16).toUpperCase(),
    IP: primaryIp(),
    LogoTitle: base.LogoTitle || '讯飞E听说',
    MAC: primaryMac(),
    Name: os.hostname(),
    OS: osName,
    OSBit: '64',
    SystemName: osName,
    Version: String(base.ClientVersion || ''),
    roomId: ''
  };
  Object.keys(defaults).forEach((k) => {
    if (base[k] === undefined || base[k] === null || base[k] === '') base[k] = defaults[k];
  });
  return base;
}

module.exports = {
  init(api) { api.respond('0'); },

  /** 返回 shell.ini 的 JSON + 页面必需的设备字段（MAC/IP/OS/Name…） */
  getconfig(api) {
    api.respond(JSON.stringify(deviceConfig(Object.assign({}, api.ctx.shellConfig))));
  },

  /**
   * 页面会传 "360:360se,ekrn:ekrn" 这类进程白名单，用于提示浏览器冲突。
   * 返回值会被 JSON.parse 后作为 pcConfig，页面从中取 computername（设备名）和 SystemVersion（系统名）。
   */
  getpcinfo(api) {
    const spoof = String(api.ctx.shellConfig.SpoofOS || '').toLowerCase();
    api.respond({
      computername: os.hostname(),
      SystemVersion: spoof === 'windows' ? 'Windows 10' : `macOS ${os.release()}`,
      SystemBit: '64'
    });
  },

  getuniqueid(api) { api.respond(machineId()); },

  CheckAudio(api) { api.respond('1'); },
  checkadapter(api) { api.respond('1'); },

  getvolume(api) { api.ctx.volume.get().then((v) => api.respond(String(v))); },
  setvolume(api) {
    const p = api.payload || {};
    api.ctx.volume.set(Number(p.volume)).then(() => api.respond('0'));
  },
  getmute(api) { api.ctx.volume.getMute().then((m) => api.respond(m ? '1' : '0')); },
  setmute(api) {
    const p = api.payload || {};
    api.ctx.volume.setMute(!!Number(p.mute)).then(() => api.respond('0'));
  },

  /** 网络连通性检查（页面用于判断是否离线） */
  netcheck(api) {
    const p = api.payload || {};
    const host = p.ip || 'statics.ets100.com';
    execFile('/sbin/ping', ['-c', '1', '-W', '2000', host], { timeout: 4000 }, (err) => {
      api.respond(err ? '0' : '1');
    });
  },

  getsysytemlocalpath(api) { api.respond(api.ctx.paths.appRoot); },

  /** 把剪贴板里的图片存到指定路径（页面用来粘贴作文/图片） */
  clipboard(api) {
    const p = api.payload || {};
    api.ctx.clipboard.saveImageTo(p.fileSavePath).then((ok) => api.respond(ok ? '1' : '0'));
  },

  /** Windows 专有：授权/激活 */
  initActAuth(api) { api.respond('0'); },
  unInitActAuth(api) { api.respond('0'); },
  actauth(api) { api.respond(''); },
  getactauth(api) { api.respond(''); },
  gettoken(api) { api.respond(''); },

  /** USB HID 设备（考试用答题器）：macOS 不做设备监听，返回空列表 */
  monitordeviceplug(api) { api.respond('{}'); },
  getdeviceinfos(api) { api.respond('{}'); },

  getroomid(api) { api.respond(''); },
  setsuspensionballconfig(api) { api.respond('0'); },
  padkeyboardup(api) { api.respond('0'); },
  closewin7padkeyboardup(api) { api.respond('0'); },
  destroy(api) { api.respond('0'); },

  /** 进程/命令类：仅允许执行应用目录内的可执行文件（页面用来跑 ffmpeg/lame） */
  executecmd(api) {
    const p = api.payload || {};
    api.ctx.exec.runGuarded(p.cmd || p.cmdline || '', {
      wait: !!p.waitexit, show: !!p.isshow
    }).then((r) => api.respond(r));
  },
  executeexe(api) {
    const p = api.payload || {};
    api.ctx.exec.runGuarded(p.cmdline || '', { wait: !!p.waitexit }).then((r) => api.respond(r));
  },
  cmd(api) {
    const p = api.payload || {};
    api.ctx.exec.runGuarded(p.cmd || '', { wait: true }).then((r) => api.respond(r));
  },
  executebat(api) {
    const p = api.payload || {};
    api.ctx.exec.runGuarded(p.batfile || '', { wait: true }).then((r) => api.respond(r));
  },
  startprocess(api) {
    const p = api.payload || {};
    api.ctx.exec.runGuarded(p.cmdline || p.exePath || p.processName || '', { wait: false })
      .then((r) => api.respond(r));
  },
  stopprocess(api) {
    const p = api.payload || {};
    api.ctx.exec.kill(p.processName || p.process || '').then((r) => api.respond(r));
  },
  processexist(api) {
    const p = api.payload || {};
    const name = String(p.processName || p.process || '');
    // 页面用它判断本地消息服务是否在跑；mq_server 跑在主进程里，直接回 true
    if (/ets_mq_server/i.test(name)) {
      let running = false;
      try { running = require('../../mq_server/main.js').isRunning(); } catch (e) { running = false; }
      api.respond(running ? 'true' : 'false');
      return;
    }
    api.ctx.exec.exists(name).then((r) => api.respond(r ? 'true' : 'false'));
  },
  killagentserver(api) { api.respond('0'); },
  getserverports(api) { api.respond('{}'); }
};
