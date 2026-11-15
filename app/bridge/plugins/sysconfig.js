'use strict';
/**
 * SysConfig 插件
 * 对应 Windows: plugins/sysconfig 段（在 shell 内部实现）
 * 页面只做 init，然后等待 SysConfig_callback_id 的配置推送。
 * 这里回一个空配置，避免页面等待超时。
 */
module.exports = {
  init(api) {
    const p = api.payload || {};
    api.respond('0');
    if (p.SysConfig_callback_id) {
      setTimeout(() => api.emit(p.SysConfig_callback_id, {}), 50);
    }
  }
};
