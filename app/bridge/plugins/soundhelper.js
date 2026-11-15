'use strict';
/**
 * soundhelper 插件（录音 / 播放 / 波形）
 * 对应 Windows: plugins/soundhelper/soundhelper.pln
 *
 * Windows 版本是讯飞自己的音频引擎（支持 speex、AQC 语音质量检测、实时数据流）。
 * macOS 版本用 Web Audio 重写：
 *   record  -> getUserMedia + AudioContext(16k) 采集，落盘 16bit 单声道 WAV
 *   datastream -> 按 100ms 推送 base64 PCM（实验性，供实时评测）
 *   play    -> decodeAudioData 播放，支持 begpos/endpos 片段播放
 *   loadfile-> 解码后计算时长与波形
 * 无法还原的部分（speex 编码、AQC 评分）做安全降级，返回成功但空数据。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

/** 每个 SndHelper 实例的状态，key = 页面传的 id */
const instances = new Map();

function getInst(id) {
  if (!instances.has(id)) {
    instances.set(id, {
      id,
      recording: null,
      player: null,
      buffer: null,
      filePath: '',
      ctx: null
    });
  }
  return instances.get(id);
}

/** 播放用的 AudioContext：跟随设备默认采样率，保证音乐类音频音质 */
function audioCtx(inst) {
  if (!inst.ctx || inst.ctx.state === 'closed') {
    const AC = window.AudioContext || window.webkitAudioContext;
    inst.ctx = new AC();
  }
  if (inst.ctx.state === 'suspended') inst.ctx.resume().catch(() => {});
  return inst.ctx;
}

/**
 * 录音用的 AudioContext：强制 16kHz 单声道。
 * 讯飞评测引擎只认 16k PCM，而设备默认采样率往往是 24k/48k（本机实测 24000），
 * 直接按 ctx.sampleRate 存盘会得到 24k 的 wav，上传后评测结果异常。
 * 指定 sampleRate 后 Chromium 会自动把麦克风流重采样到 16k。
 */
const REC_RATE = 16000;
function recordCtx(inst) {
  if (!inst.recCtx || inst.recCtx.state === 'closed') {
    const AC = window.AudioContext || window.webkitAudioContext;
    try {
      inst.recCtx = new AC({ sampleRate: REC_RATE });
    } catch (e) {
      inst.recCtx = new AC(); // 老版本不支持指定采样率时退回默认
    }
  }
  if (inst.recCtx.state === 'suspended') inst.recCtx.resume().catch(() => {});
  return inst.recCtx;
}

/** Float32 -> 16bit PCM WAV */
function encodeWav(float32, sampleRate) {
  const len = float32.length;
  const buf = Buffer.alloc(44 + len * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + len * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(len * 2, 40);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, 44 + i * 2);
  }
  return buf;
}

/** 通过自定义协议读取本地音频并解码（页面是 https 源，不能直接读 file://） */
async function decodeLocal(inst, filePath) {
  const url = 'etsfile://local/' + encodeURIComponent(filePath).replace(/%2F/g, '/');
  const res = await fetch(url);
  const ab = await res.arrayBuffer();
  const ctx = audioCtx(inst);
  return ctx.decodeAudioData(ab);
}

/** 计算波形峰值（0-100 的整数数组） */
function peaks(buffer, count = 600) {
  const ch = buffer.getChannelData(0);
  const block = Math.max(1, Math.floor(ch.length / count));
  const out = [];
  for (let i = 0; i < count; i++) {
    let max = 0;
    const start = i * block;
    for (let j = 0; j < block && start + j < ch.length; j++) {
      const v = Math.abs(ch[start + j]);
      if (v > max) max = v;
    }
    out.push(Math.min(100, Math.round(max * 100)));
  }
  return out;
}

function ffmpegPath(ctx) {
  const p = ctx.paths.ffmpeg;
  return p && fs.existsSync(p) ? p : null;
}

module.exports = {
  init(api) {
    const p = api.payload || {};
    const inst = getInst(p.id);
    inst.callbacks = p; // 保存所有回调 id
    api.respond('0');
  },

  /** 开始录音：{id, recordTime, filePath, dataStreamType} */
  record(api) {
    const p = api.payload || {};
    const inst = getInst(p.id);
    const cbs = inst.callbacks || {};
    const outPath = api.ctx.resolve(p.filePath || './localdata/record.wav');
    inst.recordPath = outPath;
    const recordTime = Number(p.recordTime || 0);

    const finish = async (reason) => {
      const rec = inst.recording;
      if (!rec) return;
      inst.recording = null;
      try { rec.timer && clearTimeout(rec.timer); } catch (e) { /* ignore */ }
      rec.stream.getTracks().forEach((t) => t.stop());
      try { await rec.proc && rec.proc.disconnect(); } catch (e) { /* ignore */ }
      const wav = encodeWav(rec.pcm, rec.sampleRate);
      try {
        await fsp.mkdir(path.dirname(outPath), { recursive: true });
        await fsp.writeFile(outPath, wav);
        api.log.info(`[soundhelper] 录音落盘 ${outPath} ${wav.length} 字节 采样率=${rec.sampleRate} 数据流=${rec.dsChunks}块/${rec.dsBytes}字节`);
      } catch (e) {
        api.log.error(`[soundhelper] 录音落盘失败 ${outPath}: ${e.message}`);
      }
      const result = {
        code: 0,
        filePath: outPath,
        time_len: Math.round((rec.pcm.length / rec.sampleRate) * 100) / 100,
        reason: reason || 'stop'
      };
      api.log.info(`[soundhelper] 录音结束 ${outPath} ${result.time_len}s`);
      if (cbs.recordend_callback_id) api.emit(cbs.recordend_callback_id, result);
      api.respond(result);
    };

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 16000
          }
        });
        const ctx = recordCtx(inst);
        const source = ctx.createMediaStreamSource(stream);
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        // ScriptProcessor 必须接到 destination 才会持续触发 onaudioprocess，
        // 但直连会把麦克风原声放出来（回声/啸叫），中间串一个 gain=0 的节点。
        const mute = ctx.createGain();
        mute.gain.value = 0;
        const rec = {
          stream,
          proc,
          mute,
          pcm: new Float32Array(0),
          sampleRate: ctx.sampleRate,
          timer: null,
          seq: 0,
          dsChunks: 0,
          dsBytes: 0,
          lastEmit: 0,
          startedAt: Date.now()
        };
        inst.recording = rec;
        api.log.info(`[soundhelper] 录音开始 采样率=${ctx.sampleRate} 期望=${REC_RATE} 轨道=${stream.getAudioTracks().length}`);

        proc.onaudioprocess = (ev) => {
          const input = ev.inputBuffer.getChannelData(0);
          const merged = new Float32Array(rec.pcm.length + input.length);
          merged.set(rec.pcm, 0);
          merged.set(input, rec.pcm.length);
          rec.pcm = merged;

          // 能量回调（页面画音量条）
          if (cbs.energy_callback_id) {
            let sum = 0;
            for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
            const rms = Math.sqrt(sum / input.length);
            const energy = Math.min(100, Math.round(rms * 400));
            api.emit(cbs.energy_callback_id, { id: inst.id, energy });
          }

          // 实时数据流：每 ~100ms 推一次。
          // 页面收到后会直接丢给评测实例（ise.send(e) → toUint8Array.base64解码），
          // 所以这里必须是**纯 base64 字符串**（16k 单声道 PCM16 裸流，无 WAV 头），
          // 以前发的是 {id,seq,data} 对象，页面 e.replace 直接抛错 → 引擎收不到音频 → 0 分。
          const now = Date.now();
          if (cbs.datastream_callback_id && now - rec.lastEmit > 100) {
            rec.lastEmit = now;
            const chunk = encodeWav(input, rec.sampleRate).slice(44);
            rec.seq += 1;
            rec.dsChunks += 1;
            rec.dsBytes += chunk.length;
            api.emit(cbs.datastream_callback_id, chunk.toString('base64'));
          }
        };
        source.connect(proc);
        proc.connect(mute);
        mute.connect(ctx.destination);

        if (cbs.recordbegin_callback_id) api.emit(cbs.recordbegin_callback_id, { id: inst.id, filePath: outPath });
        api.respond({ code: 0, msg: 'recording', filePath: outPath });

        if (recordTime > 0) {
          // 页面传的一直是**0.1 秒为单位**（record_time / 0.1 取整）：
          //   50  -> 5 秒（单词跟读）
          //   100 -> 10 秒
          //   1000-> 100 秒（整句朗读的最大时长）
          // 之前先按 x1000 当毫秒算、后改成 >600 就不换算，两种都会提前/错后截断：
          // 1000 被当成 1 秒，句子刚开口就被掐掉，评测直接判「请正常朗读」。
          const ms = recordTime * 100;
          rec.timer = setTimeout(() => finish('timeout'), ms);
        }
      } catch (e) {
        api.log.error(`[soundhelper] 录音启动失败: ${e.message}`);
        if (cbs.error_callback_id) api.emit(cbs.error_callback_id, e.message);
        api.respond({ code: -1, msg: e.message });
      }
    })();
  },

  /** 播放：{id, filepath, begpos, endpos}（秒） */
  play(api) {
    const p = api.payload || {};
    const inst = getInst(p.id);
    const cbs = inst.callbacks || {};
    const file = api.ctx.resolve(p.filepath || p.filePath);

    (async () => {
      try {
        stopPlayer(inst);
        const buffer = await decodeLocal(inst, file);
        inst.buffer = buffer;
        const ctx = audioCtx(inst);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        // begpos/endpos 在 Windows 客户端里是毫秒，个别页面传秒。
        // 判定规则：数值超过文件时长、但除以 1000 后落在时长内 → 按毫秒处理。
        // 以前一律当秒用，传 1500（毫秒）会被当成第 1500 秒，直接静音。
        const total = buffer.duration;
        const toSec = (v) => {
          const n = Number(v || 0);
          if (!n) return 0;
          if (n > total && n / 1000 <= total) return n / 1000;
          return n;
        };
        const begin = Math.min(toSec(p.begpos), total);
        const end = p.endpos ? Math.min(toSec(p.endpos), total) : 0;
        const playLen = end > begin ? end - begin : undefined;
        src.start(0, begin, playLen);

        const player = { src, begin, startedAt: ctx.currentTime, offset: begin, paused: false, tick: null };
        inst.player = player;

        if (cbs.playbegin_callback_id) {
          api.emit(cbs.playbegin_callback_id, { time_len: buffer.duration, begpos: begin, endpos: end || buffer.duration });
        }
        player.tick = setInterval(() => {
          if (player.paused) return;
          const pos = player.begin + (ctx.currentTime - player.startedAt);
          if (cbs.curplaypos_callback_id) api.emit(cbs.curplaypos_callback_id, { pos: Math.min(pos, buffer.duration) });
        }, 200);

        src.onended = () => {
          if (player.paused) return;
          clearInterval(player.tick);
          inst.player = null;
          if (cbs.playend_callback_id) api.emit(cbs.playend_callback_id, { code: 0 });
        };
        api.respond({ code: 0, time_len: buffer.duration });
      } catch (e) {
        api.log.error(`[soundhelper] 播放失败 ${file}: ${e.message}`);
        if (cbs.error_callback_id) api.emit(cbs.error_callback_id, e.message);
        api.respond({ code: -1, msg: e.message });
      }
    })();
  },

  pause(api) {
    const p = api.payload || {};
    const inst = getInst(p.id);
    const pl = inst.player;
    if (pl && !pl.paused) {
      pl.paused = true;
      pl.offset = pl.begin + (audioCtx(inst).currentTime - pl.startedAt);
      clearInterval(pl.tick);
      try { pl.src.stop(); } catch (e) { /* ignore */ }
      inst.player = null;
      inst.pausedAt = pl.offset;
    }
    api.respond('0');
  },

  continue(api) {
    const p = api.payload || {};
    const inst = getInst(p.id);
    const cbs = inst.callbacks || {};
    const from = inst.pausedAt || 0;
    if (!inst.buffer) { api.respond('0'); return; }
    const ctx = audioCtx(inst);
    const src = ctx.createBufferSource();
    src.buffer = inst.buffer;
    src.connect(ctx.destination);
    src.start(0, from);
    const player = { src, begin: from, startedAt: ctx.currentTime, paused: false, tick: null };
    inst.player = player;
    player.tick = setInterval(() => {
      if (player.paused) return;
      const pos = player.begin + (ctx.currentTime - player.startedAt);
      if (cbs.curplaypos_callback_id) api.emit(cbs.curplaypos_callback_id, { pos });
    }, 200);
    src.onended = () => {
      if (player.paused) return;
      clearInterval(player.tick);
      inst.player = null;
      if (cbs.playend_callback_id) api.emit(cbs.playend_callback_id, { code: 0 });
    };
    api.respond('0');
  },

  stop(api) {
    const p = api.payload || {};
    const inst = getInst(p.id);
    // 正在录音则结束录音
    if (inst.recording) {
      const rec = inst.recording;
      const cbs = inst.callbacks || {};
      inst.recording = null;
      if (rec.timer) clearTimeout(rec.timer);
      rec.stream.getTracks().forEach((t) => t.stop());
      try { rec.proc.disconnect(); } catch (e) { /* ignore */ }
      const wav = encodeWav(rec.pcm, rec.sampleRate);
      const out = inst.recordPath || path.join(api.ctx.paths.dataRoot, 'localdata/record.wav');
      api.log.info(`[soundhelper] 录音停止 数据流=${rec.dsChunks}块/${rec.dsBytes}字节 采样率=${rec.sampleRate}`);
      fsp.mkdir(path.dirname(out), { recursive: true })
        .then(() => fsp.writeFile(out, wav))
        .then(() => {
          const result = {
            code: 0, filePath: out,
            time_len: Math.round((rec.pcm.length / rec.sampleRate) * 100) / 100, reason: 'stop'
          };
          if (cbs.recordend_callback_id) api.emit(cbs.recordend_callback_id, result);
          api.respond(result);
        })
        .catch(() => api.respond('0'));
      return;
    }
    stopPlayer(inst);
    api.respond('0');
  },

  /** 扫描文件：算时长 + 波形 */
  loadfile(api) {
    const p = api.payload || {};
    const inst = getInst(p.id);
    const cbs = inst.callbacks || {};
    const file = api.ctx.resolve(p.filepath || p.filePath);
    (async () => {
      try {
        const buffer = await decodeLocal(inst, file);
        inst.buffer = buffer;
        inst.filePath = file;
        // 波形按原生插件的约定是 "12|45|78" 这样的竖线分隔字符串（页面直接 e.split("|")），
        // 传数组对象会让页面拿到 NaN。
        const wave = peaks(buffer).join('|');
        if (cbs.scanfilebegin_callback_id) {
          api.emit(cbs.scanfilebegin_callback_id, { time_len: buffer.duration });
        }
        if (cbs.scanfileend_callback_id) {
          api.emit(cbs.scanfileend_callback_id, { time_len: buffer.duration, waveform: wave });
        }
        if (cbs.waveform_callback_id) api.emit(cbs.waveform_callback_id, wave);
        api.respond({ code: 0, time_len: buffer.duration });
      } catch (e) {
        api.log.warn(`[soundhelper] loadfile 失败 ${file}: ${e.message}`);
        if (cbs.scanfilebegin_callback_id) api.emit(cbs.scanfilebegin_callback_id, { time_len: 0 });
        if (cbs.scanfileend_callback_id) api.emit(cbs.scanfileend_callback_id, { time_len: 0, waveform: [] });
        api.respond({ code: -1, msg: e.message });
      }
    })();
  },

  /** 转码（页面用它把 wav 转 mp3 上传）；有 ffmpeg 就用，没有则原样复制 */
  convertfile(api) {
    const p = api.payload || {};
    const src = api.ctx.resolve(p.filepath || p.srcPath || p.filePath);
    const dst = api.ctx.resolve(p.destpath || p.destPath || p.outPath);
    const ff = ffmpegPath(api.ctx);
    fsp.mkdir(path.dirname(dst), { recursive: true })
      .then(() => {
        if (!ff) return fsp.copyFile(src, dst);
        return new Promise((resolve, reject) => {
          execFile(ff, ['-y', '-i', src, dst], { timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
        });
      })
      .then(() => api.respond({ code: 0, filePath: dst }))
      .catch((e) => { api.log.warn(`[soundhelper] convert 失败: ${e.message}`); api.respond({ code: -1, msg: e.message }); });
  },

  /** 多段录音合并并转 mp3 */
  combineandconvertwavtomp3(api) {
    const p = api.payload || {};
    const list = (p.filePaths || p.files || []).map((x) => api.ctx.resolve(x));
    const dst = api.ctx.resolve(p.destPath || p.outPath || p.filePath);
    const ff = ffmpegPath(api.ctx);
    if (!ff || list.length === 0) {
      // 无 ffmpeg：直接返回第一段，保证流程不中断
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

  /** 语音质量检测（AQC）：macOS 无对应引擎，返回通过 */
  aqcwavfile(api) { api.respond({ code: 0, result: 1 }); },
  checkwovfile(api) { api.respond({ code: 0, result: 1 }); },
  checkvoice(api) { api.respond({ code: 0, result: 1 }); },
  trace(api) { api.respond('0'); },

  destroy(api) {
    const p = api.payload || {};
    const inst = getInst(p.id);
    stopPlayer(inst);
    if (inst.recording) {
      inst.recording.stream.getTracks().forEach((t) => t.stop());
      try { inst.recording.proc.disconnect(); } catch (e) { /* ignore */ }
      inst.recording = null;
    }
    instances.delete(p.id);
    api.respond('0');
  },

};

function stopPlayer(inst) {
  if (inst.player) {
    try { inst.player.src.stop(); } catch (e) { /* ignore */ }
    clearInterval(inst.player.tick);
    inst.player = null;
  }
}
