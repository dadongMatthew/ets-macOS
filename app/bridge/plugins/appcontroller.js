'use strict';
/**
 * appcontroller 插件（窗口控制）
 * 对应 Windows: plugins/appcontroller/appcontroller.pln
 *
 * 页面用它做无边框窗口：拖拽、最大化、最小化、关闭、置位。
 * macOS 侧全部转成 BrowserWindow 操作，通过 preload 里的 ctx.win 调用主进程。
 */
module.exports = {
  init(api) {
    // payload: { id, error_callback_id, win_x, win_y, win_w, win_h, ... }
    api.respond('0');
  },
  close(api) { api.ctx.win.close(); api.respond('0'); },
  maximize(api) { api.ctx.win.maximize(); api.respond('0'); },
  minimize(api) { api.ctx.win.minimize(); api.respond('0'); },
  restore(api) { api.ctx.win.restore(); api.respond('0'); },
  fullscreen(api) { api.ctx.win.fullscreen(true); api.respond('0'); },
  reduction(api) { api.ctx.win.fullscreen(false); api.respond('0'); },
  hide(api) { api.ctx.win.hide(); api.respond('0'); },
  show(api) { api.ctx.win.show(); api.respond('0'); },
  get_win_pos(api) {
    api.ctx.win.getPos().then((p) => api.respond(p));
  },
  set_win_pos(api) {
    const p = api.payload || {};
    api.ctx.win.setPos(p).then(() => api.respond('0'));
  },
  /**
   * 拖拽：页面每帧上报 {startPoint:{x,y}, endPoint:{x,y}}，但这里是 clientX/clientY，
   * 不是真实屏幕坐标，而且只在 `document.getElementById(topDomId)` 上绑定了 mousedown ——
   * 没有该 canvas 的页面（隐私弹窗、静态子窗口）就完全拖不动。
   *
   * 因此 macOS 上这条链路只回 '0' 不移动窗口，统一交给 preload 里的兜底拖动
   * （基于 screenX/screenY + 绝对定位）。两边同时 setBounds 会造成抖动和位移翻倍。
   */
  move(api) { api.respond('0'); },
  /** 拉起外部答题程序：macOS 上没有对应 exe，回 apprun 回调表示已“启动” */
  startapp(api) {
    const p = api.payload || {};
    api.log.warn('[appcontroller] startapp 在 macOS 上无对应程序，已忽略');
    if (p.apprun_callback_id) api.emit(p.apprun_callback_id, '0');
    api.respond('0');
  },
  idg_exist(api) { api.respond('0'); }
};
