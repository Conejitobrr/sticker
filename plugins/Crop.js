'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const execFileAsync = promisify(execFile);
const TEMP_DIR = path.join(process.cwd(), 'temp');

function ensureTemp() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function unwrapMessage(message = {}) {
  if (!message) return {};
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.documentWithCaptionMessage?.message) return unwrapMessage(message.documentWithCaptionMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  return message;
}

function getQuotedMessage(msg) {
  const m = unwrapMessage(msg.message);
  const ctx =
    m.extendedTextMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo;
  return ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
}

function getVideoInfo(message) {
  if (!message) return null;
  if (message.videoMessage) {
    return { media: message.videoMessage, downloadType: 'video' };
  }
  if (message.documentMessage && (message.documentMessage.mimetype || '').startsWith('video/')) {
    return { media: message.documentMessage, downloadType: 'document' };
  }
  return null;
}

async function getVideoMeta(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,side_data_list:stream_tags=rotate:format=duration',
      '-of', 'json',
      filePath
    ]);
    const data = JSON.parse(stdout || '{}');
    const stream = data.streams?.[0] || {};
    let width = Number(stream.width || 0);
    let height = Number(stream.height || 0);
    const duration = parseFloat(data.format?.duration || '0') || 0;

    // Verificar rotación para comparar bien contra cropdetect
    let rot = Number(stream.tags?.rotate || 0);
    if (!rot && Array.isArray(stream.side_data_list)) {
      const disp = stream.side_data_list.find(s => typeof s.rotation === 'number');
      if (disp) rot = disp.rotation;
    }
    if (Math.abs(rot) === 90 || Math.abs(rot) === 270) {
      [width, height] = [height, width];
    }

    return { width, height, duration };
  } catch {
    return { width: 0, height: 0, duration: 0 };
  }
}

// 🔍 Detecta automáticamente rayas negras arriba, abajo y a los lados
async function detectBlackBars(filePath, duration = 0) {
  // Saltamos el primer 15% por si el video inicia en negro (fade-in)
  const startSec = duration > 4 ? (duration * 0.15).toFixed(2) : '0';
  const scanSec = duration > 0 ? Math.min(6, Math.max(2, duration * 0.65)).toFixed(2) : '5';

  const { stderr } = await execFileAsync('ffmpeg', [
    '-ss', startSec,
    '-i', filePath,
    '-t', scanSec,
    '-vf', 'cropdetect=limit=28:round=2:reset=0',
    '-an',
    '-f', 'null',
    '-'
  ], { maxBuffer: 10 * 1024 * 1024, timeout: 60000 });

  const matches = [...String(stderr || '').matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!matches.length) return null;

  const last = matches[matches.length - 1];
  const w = Number(last[1]) - (Number(last[1]) % 2);
  const h = Number(last[2]) - (Number(last[2]) % 2);
  const x = Number(last[3]);
  const y = Number(last[4]);

  if (w < 64 || h < 64) return null;
  return { w, h, x, y };
}

// 📐 Construye el filtro de proporción exacta (ej. 4:3, 3:4, 4:5, 1:1, 16:9)
function buildRatioCropFilter(wRatio, hRatio, align = 'centro') {
  const outW = `trunc(min(iw\\,ih*${wRatio}/${hRatio})/2)*2`;
  const outH = `trunc(min(ih\\,iw*${hRatio}/${wRatio})/2)*2`;

  let posX = '(iw-ow)/2';
  let posY = '(ih-oh)/2';

  if (align === 'arriba' || align === 'top') posY = '0';
  else if (align === 'abajo' || align === 'bottom') posY = 'ih-oh';
  else if (align === 'izq' || align === 'izquierda' || align === 'left') posX = '0';
  else if (align === 'der' || align === 'derecha' || align === 'right') posX = 'iw-ow';

  return `crop=${outW}:${outH}:${posX}:${posY}`;
}

function parseRatio(token = '') {
  const presets = {
    cuadrado: [1, 1],
    square: [1, 1],
    clasico: [4, 3],
    vertical: [3, 4],
    portrait: [4, 5],
    insta: [4, 5],
    horizontal: [16, 9],
    cine: [21, 9],
    tiktok: [9, 16]
  };
  const key = token.toLowerCase();
  if (presets[key]) return presets[key];

  const m = key.match(/^(\d+(?:\.\d+)?)[:/x](\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!w || !h || w <= 0 || h <= 0 || w / h > 5 || h / w > 5) return null;
  return [w, h];
}

function parsePercent(token = '') {
  const m = token.match(/^(\d+(?:\.\d+)?)%$/);
  if (!m) return null;
  const val = parseFloat(m[1]);
  if (isNaN(val) || val <= 0 || val >= 45) return null;
  return val;
}

module.exports = {
  name: 'crop',
  aliases: ['encuadre', 'formato', 'sinbordes', 'aspecto'],
  category: 'multimedia',
  desc: 'Recorta el encuadre de un video (4:3, 3:4, 1:1, 16:9) o elimina rayas negras automáticamente',

  execute: async ({ sock, msg, remoteJid, args, commandName, reply }) => {
    let inputPath = null;
    let outputPath = null;

    try {
      const cmd = commandName.toLowerCase();
      const rawArgs = [...args];

      // Si escribe .sinbordes sin argumentos, activa modo auto directo
      if (cmd === 'sinbordes' && rawArgs.length === 0) {
        rawArgs.push('auto');
      }

      if (!rawArgs.length) {
        return reply(
          `🎬 *ENCUADRE Y RECORTE DE VIDEO* 📐\n\n` +
          `Responde a un *Video* usando cualquiera de estos modos:\n\n` +
          `🖤 *Quitar rayas negras automático:*\n` +
          `▪️ *.sinbordes* _(o *.crop auto*)_\n\n` +
          `📐 *Cambiar formato / proporción:*\n` +
          `▪️ *.crop 4:3* _(Clásico horizontal)_\n` +
          `▪️ *.crop 3:4* _(Un poco más alargado vertical)_\n` +
          `▪️ *.crop 4:5* _(Formato Instagram)_\n` +
          `▪️ *.crop 1:1* _(Cuadrado)_\n` +
          `▪️ *.crop 16:9* _(Panorámico)_\n` +
          `▪️ *.crop 5:6* _(¡Cualquier medida W:H!)_\n\n` +
          `✨ *Trucos extra:*\n` +
          `▪️ *.crop 4:3 auto* _(Quita bordes negros primero y luego lo pasa a 4:3)_\n` +
          `▪️ *.crop 4:3 arriba* / *abajo* _(Mueve el encuadre si el video no está centrado)_\n` +
          `▪️ *.crop 15%* _(Corta 15% arriba y 15% abajo si las barras son difuminadas)_`
        );
      }

      const targetMsg = getQuotedMessage(msg) || unwrapMessage(msg.message);
      const info = getVideoInfo(targetMsg);

      if (!info) {
        return reply('❌ Envía o responde al *video* que quieres recortar.');
      }

      // Interpretar argumentos
      let useAuto = false;
      let ratio = null;
      let percentV = null;
      let align = 'centro';

      for (const a of rawArgs) {
        const lower = a.toLowerCase();
        if (['auto', 'sinbordes', 'bordes', 'negro', 'negros'].includes(lower)) {
          useAuto = true;
        } else if (['arriba', 'abajo', 'izq', 'izquierda', 'der', 'derecha', 'top', 'bottom', 'left', 'right', 'centro'].includes(lower)) {
          align = lower;
        } else if (!ratio && parseRatio(lower)) {
          ratio = parseRatio(lower);
        } else if (percentV === null && parsePercent(lower) !== null) {
          percentV = parsePercent(lower);
        }
      }

      if (!useAuto && !ratio && percentV === null) {
        return reply('❌ Formato no válido. Usa por ejemplo: *.crop 4:3*, *.crop 3:4*, *.crop auto* o *.crop 15%*');
      }

      // Desvío de cita hacia el video original
      let targetQuote = msg;
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      if (ctx?.stanzaId && ctx?.participant) {
        targetQuote = {
          key: {
            remoteJid: msg.key.remoteJid,
            id: ctx.stanzaId,
            participant: ctx.participant
          },
          message: ctx.quotedMessage || {}
        };
      }

      ensureTemp();
      const label = [
        useAuto ? 'Auto sin bordes' : null,
        ratio ? `${ratio[0]}:${ratio[1]}` : null,
        percentV !== null ? `-${percentV}% arriba/abajo` : null,
        align !== 'centro' ? `(${align})` : null
      ].filter(Boolean).join(' + ');

      const waitMsg = await sock.sendMessage(remoteJid, {
        text: `✂️ Procesando encuadre *${label}*...`
      }, { quoted: msg });

      const stream = await downloadContentFromMessage(info.media, info.downloadType);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);

      const id = `${Date.now()}_${Math.floor(Math.random() * 9999)}`;
      inputPath = path.join(TEMP_DIR, `crop_in_${id}.mp4`);
      outputPath = path.join(TEMP_DIR, `crop_out_${id}.mp4`);
      fs.writeFileSync(inputPath, Buffer.concat(chunks));

      const filters = [];
      const meta = await getVideoMeta(inputPath);

      // 1. Si pidió modo auto, detectamos los bordes negros
      if (useAuto) {
        const box = await detectBlackBars(inputPath, meta.duration);
        const hasRealBars = box && (
          !meta.width || !meta.height ||
          box.w < meta.width - 8 || box.h < meta.height - 8
        );

        if (hasRealBars) {
          filters.push(`crop=${box.w}:${box.h}:${box.x}:${box.y}`);
        } else if (!ratio && percentV === null) {
          try { await sock.sendMessage(remoteJid, { delete: waitMsg.key }); } catch {}
          return reply('⚠️ No detecté rayas negras sólidas en este video.\n💡 Si las barras son borrosas o tienen texto, usa un formato directo como *.crop 4:3*, *.crop 3:4* o *.crop 15%*.');
        }
      }

      // 2. Si pidió recorte porcentual arriba y abajo
      if (percentV !== null) {
        const keepFactor = (1 - (percentV * 2) / 100).toFixed(4);
        const offsetFactor = (percentV / 100).toFixed(4);
        filters.push(`crop=trunc(iw/2)*2:trunc(ih*${keepFactor}/2)*2:0:ih*${offsetFactor}`);
      }

      // 3. Si pidió una relación de aspecto específica (4:3, 3:4, 4:5, 1:1, etc.)
      if (ratio) {
        filters.push(buildRatioCropFilter(ratio[0], ratio[1], align));
      }

      filters.push('setsar=1');

      await execFileAsync('ffmpeg', [
        '-y', '-i', inputPath,
        '-vf', filters.join(','),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath
      ], { timeout: 180000 });

      const outMeta = await getVideoMeta(outputPath);
      const resText = outMeta.width && outMeta.height ? `\n📏 Resolución: *${outMeta.width}x${outMeta.height}*` : '';

      await sock.sendMessage(remoteJid, {
        video: fs.readFileSync(outputPath),
        mimetype: 'video/mp4',
        caption: `🎬 *Encuadre aplicado:* ${label}${resText}`
      }, { quoted: targetQuote });

      try { await sock.sendMessage(remoteJid, { delete: waitMsg.key }); } catch {}

    } catch (err) {
      console.log('❌ Error en crop.js:', err?.message || err);
      return reply('❌ Ocurrió un error al recortar el video.');
    } finally {
      [inputPath, outputPath].forEach(f => {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
      });
    }
  }
};
