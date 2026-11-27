'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { unwrapMessage } = require('../lib/utils');

const execFileAsync = promisify(execFile);
const TEMP_DIR = path.join(process.cwd(), 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

async function getWebpAnimInfo(webpPath) {
  try {
    const { stdout } = await execFileAsync('webpmux', ['-info', webpPath], { timeout: 15000 });
    const framesMatch = stdout.match(/Number of frames:\s*(\d+)/i);
    const frames = framesMatch ? parseInt(framesMatch[1], 10) : 1;

    // Calcular FPS reales a partir de la duración en ms de los fotogramas
    const durations = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*\d+:\s+\d+\s+\d+\s+\w+\s+\d+\s+\d+\s+(\d+)\s+/);
      if (m) {
        const ms = parseInt(m[1], 10);
        if (ms > 0) durations.push(ms);
      }
    }

    let fps = 12;
    if (durations.length) {
      const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length;
      fps = Math.max(5, Math.min(30, Math.round(1000 / avgMs)));
    }

    return { isAnimated: frames > 1, frames, fps };
  } catch {
    return { isAnimated: null, frames: 0, fps: 12 };
  }
}

async function convertAnimatedWebpToMp4(inWebp, outMp4, id, animInfo, tempFiles) {
  // 1️⃣ Método 1: ImageMagick coalesce -> GIF (conserva tiempos exactos) -> MP4
  try {
    const midGif = path.join(TEMP_DIR, `tovid_${id}.gif`);
    tempFiles.push(midGif);

    await execFileAsync('convert', [
      inWebp,
      '-coalesce',
      '-background', '#000000',
      '-alpha', 'remove',
      '-alpha', 'off',
      midGif
    ], { timeout: 90000 });

    await execFileAsync('ffmpeg', [
      '-y', '-i', midGif,
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      outMp4
    ], { timeout: 90000 });

    if (fs.existsSync(outMp4) && fs.statSync(outMp4).size > 1024) return;
  } catch {}

  // 2️⃣ Método 2: FFmpeg directo sobre el WebP animado
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', inWebp,
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      outMp4
    ], { timeout: 90000 });

    if (fs.existsSync(outMp4) && fs.statSync(outMp4).size > 1024) return;
  } catch {}

  // 3️⃣ Método 3 (Respaldo extremo): Extraer fotogramas con webpmux + dwebp
  const framesDir = path.join(TEMP_DIR, `frames_${id}`);
  fs.mkdirSync(framesDir, { recursive: true });
  tempFiles.push(framesDir);

  const totalFrames = Math.min(animInfo.frames || 60, 150);
  for (let i = 1; i <= totalFrames; i++) {
    const fWebp = path.join(framesDir, `f_${String(i).padStart(4, '0')}.webp`);
    const fPng = path.join(framesDir, `f_${String(i).padStart(4, '0')}.png`);
    await execFileAsync('webpmux', ['-get', 'frame', String(i), inWebp, '-o', fWebp], { timeout: 15000 });
    await execFileAsync('dwebp', [fWebp, '-o', fPng], { timeout: 15000 });
  }

  await execFileAsync('ffmpeg', [
    '-y',
    '-framerate', String(animInfo.fps || 12),
    '-i', path.join(framesDir, 'f_%04d.png'),
    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black',
    '-movflags', '+faststart',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '23',
    outMp4
  ], { timeout: 90000 });
}

module.exports = {
  name: 'tovideo',
  aliases: ['tomp4', 'avideo', 'togif'],
  category: 'convertidores',
  desc: 'Convierte un sticker animado en video MP4 o GIF en bucle (.togif)',

  execute: async ({ sock, msg, remoteJid, commandName, reply }) => {
    const tempFiles = [];

    try {
      const m = unwrapMessage(msg.message);
      const ctx = m.extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
      const stk = quoted?.stickerMessage;

      if (!stk) {
        return reply('❌ Responde a un *sticker con movimiento* usando *.tovideo* (o *.togif*).');
      }

      const stream = await downloadContentFromMessage(stk, 'sticker');
      const chunks = [];
      for await (const c of stream) chunks.push(c);

      const id = `${Date.now()}_${Math.floor(Math.random() * 9999)}`;
      const inWebp = path.join(TEMP_DIR, `tovid_in_${id}.webp`);
      const outMp4 = path.join(TEMP_DIR, `tovid_out_${id}.mp4`);
      tempFiles.push(inWebp, outMp4);

      fs.writeFileSync(inWebp, Buffer.concat(chunks));

      const animInfo = await getWebpAnimInfo(inWebp);
      const isAnim = animInfo.isAnimated !== null ? animInfo.isAnimated : !!stk.isAnimated;

      if (!isAnim) {
        return reply('⚠️ Ese sticker es estático (sin movimiento).\n📸 Usa *.toimage* para convertirlo en foto.');
      }

      await convertAnimatedWebpToMp4(inWebp, outMp4, id, animInfo, tempFiles);

      let finalMp4 = outMp4;

      // 🔊 Si el sticker trae audio nativo adjunto, lo integra dentro del MP4
      if (stk.audioMessage && stk.audioMessage.mediaKey) {
        try {
          const audStream = await downloadContentFromMessage(stk.audioMessage, 'audio');
          const audChunks = [];
          for await (const c of audStream) audChunks.push(c);

          const audPath = path.join(TEMP_DIR, `tovid_aud_${id}.ogg`);
          const muxedMp4 = path.join(TEMP_DIR, `tovid_mux_${id}.mp4`);
          tempFiles.push(audPath, muxedMp4);
          fs.writeFileSync(audPath, Buffer.concat(audChunks));

          await execFileAsync('ffmpeg', [
            '-y',
            '-stream_loop', '-1', '-i', outMp4,
            '-i', audPath,
            '-shortest',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            muxedMp4
          ], { timeout: 90000 });

          if (fs.existsSync(muxedMp4) && fs.statSync(muxedMp4).size > 1024) {
            finalMp4 = muxedMp4;
          }
        } catch {}
      }

      const asGif = commandName.toLowerCase() === 'togif';

      await sock.sendMessage(remoteJid, {
        video: fs.readFileSync(finalMp4),
        mimetype: 'video/mp4',
        gifPlayback: asGif
      }, { quoted: msg });

    } catch (err) {
      console.log('❌ Error en tovideo.js:', err?.message || err);
      return reply('❌ No se pudo convertir el sticker animado a video.');
    } finally {
      for (const f of tempFiles) {
        try {
          if (fs.existsSync(f)) {
            if (fs.statSync(f).isDirectory()) fs.rmSync(f, { recursive: true, force: true });
            else fs.unlinkSync(f);
          }
        } catch {}
      }
    }
  }
};
