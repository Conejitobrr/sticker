'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  downloadContentFromMessage,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  proto
} = require('@whiskeysockets/baileys');

const execFileAsync = promisify(execFile);
const TEMP_DIR = path.join(process.cwd(), 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const STICKER_PACK_NAME = '𝑺𝒊𝒓𝒊𝒖𝒔𝑩𝒐𝒕';
const STICKER_AUTHOR = '';
const FORCE_VIDEO_SEC = 10;         // Forzado directamente a 10 segundos
const MAX_WEBP_BYTES = 490 * 1024;  // Margen seguro bajo el límite de 500 KB

const pendingAudios = new Map();

function patchProtoForSoundStickers() {
  const Message = proto.Message;
  const StickerMessage = proto.Message?.StickerMessage;
  const AudioMessage = proto.Message?.AudioMessage;
  const FutureProofMessage = proto.Message?.FutureProofMessage;

  if (StickerMessage && AudioMessage && !StickerMessage._soundStickerPatched) {
    const origEncode = StickerMessage.encode.bind(StickerMessage);
    StickerMessage.encode = function (message, writer) {
      writer = origEncode(message, writer);
      if (message && message.audioMessage != null) {
        AudioMessage.encode(message.audioMessage, writer.uint32(210).fork()).ldelim();
      }
      return writer;
    };

    const origFromObject = StickerMessage.fromObject.bind(StickerMessage);
    StickerMessage.fromObject = function (object) {
      const res = origFromObject(object);
      if (object && object.audioMessage != null) {
        res.audioMessage = AudioMessage.fromObject(object.audioMessage);
      }
      return res;
    };

    const origToObject = StickerMessage.toObject.bind(StickerMessage);
    StickerMessage.toObject = function (message, options) {
      const obj = origToObject(message, options);
      if (message && message.audioMessage != null) {
        obj.audioMessage = AudioMessage.toObject(message.audioMessage, options);
      }
      return obj;
    };

    StickerMessage._soundStickerPatched = true;
  }

  if (Message && FutureProofMessage && !Message._audioStickerWrapperPatched) {
    const origMsgEncode = Message.encode.bind(Message);
    Message.encode = function (message, writer) {
      writer = origMsgEncode(message, writer);
      if (message && message.audioStickerMessage != null) {
        FutureProofMessage.encode(message.audioStickerMessage, writer.uint32(1074).fork()).ldelim();
      }
      return writer;
    };

    const origMsgFromObject = Message.fromObject.bind(Message);
    Message.fromObject = function (object) {
      const res = origMsgFromObject(object);
      if (object && object.audioStickerMessage != null) {
        res.audioStickerMessage = FutureProofMessage.fromObject(object.audioStickerMessage);
      }
      return res;
    };

    Message._audioStickerWrapperPatched = true;
  }
}

patchProtoForSoundStickers();

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
  const context =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.stickerMessage?.contextInfo ||
    m.documentMessage?.contextInfo;
  return context?.quotedMessage ? unwrapMessage(context.quotedMessage) : null;
}

function getMediaInfo(message) {
  if (!message) return null;
  if (message.stickerMessage) {
    return { kind: 'sticker', media: message.stickerMessage, downloadType: 'sticker' };
  }
  if (message.videoMessage) {
    return { kind: 'video', media: message.videoMessage, downloadType: 'video' };
  }
  if (message.imageMessage) {
    return { kind: 'image', media: message.imageMessage, downloadType: 'image' };
  }
  if (message.audioMessage) {
    return { kind: 'audio', media: message.audioMessage, downloadType: 'audio' };
  }
  if (message.documentMessage) {
    const mime = message.documentMessage.mimetype || '';
    if (mime.startsWith('video/')) return { kind: 'video', media: message.documentMessage, downloadType: 'document' };
    if (mime.startsWith('image/')) return { kind: 'image', media: message.documentMessage, downloadType: 'document' };
    if (mime.startsWith('audio/')) return { kind: 'audio', media: message.documentMessage, downloadType: 'document' };
  }
  return null;
}

async function downloadMedia(media, downloadType) {
  const stream = await downloadContentFromMessage(media, downloadType);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function createExif(packName = STICKER_PACK_NAME, author = STICKER_AUTHOR) {
  const json = {
    'sticker-pack-id': 'com.siriusbot.soundsticker10s',
    'sticker-pack-name': packName,
    'sticker-pack-publisher': author,
    emojis: ['🔊']
  };
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00
  ]);
  exifHeader.writeUIntLE(jsonBuffer.length, 14, 4);
  return Buffer.concat([exifHeader, jsonBuffer]);
}

async function probeMedia(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'json',
      filePath
    ]);
    const parsed = JSON.parse(stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const hasAudio = streams.some(s => s.codec_type === 'audio');
    const duration = parseFloat(parsed.format?.duration || '0') || 0;
    return { hasAudio, duration };
  } catch {
    return { hasAudio: true, duration: FORCE_VIDEO_SEC };
  }
}

async function inspectExistingWebp(webpPath, stickerMeta = {}) {
  try {
    const { stdout } = await execFileAsync('webpmux', ['-info', webpPath], { timeout: 15000 });
    const sizeMatch = stdout.match(/Canvas size:\s*(\d+)\s*x\s*(\d+)/i);
    const framesMatch = stdout.match(/Number of frames:\s*(\d+)/i);
    const width = sizeMatch ? parseInt(sizeMatch[1], 10) : (Number(stickerMeta.width) || 512);
    const height = sizeMatch ? parseInt(sizeMatch[2], 10) : (Number(stickerMeta.height) || 512);
    const isAnimated = framesMatch ? parseInt(framesMatch[1], 10) > 1 : !!stickerMeta.isAnimated;
    return { width, height, isAnimated };
  } catch {
    return {
      width: Number(stickerMeta.width) || 512,
      height: Number(stickerMeta.height) || 512,
      isAnimated: !!stickerMeta.isAnimated
    };
  }
}

// Presets progresivos para forzar 10s completos bajo 500 KB
async function buildAnimatedWebp10s(inputPath, outputPath) {
  const presets = [
    { size: 240, fps: 9, q: 46 },
    { size: 224, fps: 8, q: 36 },
    { size: 200, fps: 7, q: 28 },
    { size: 176, fps: 6, q: 22 },
    { size: 150, fps: 6, q: 16 },
    { size: 128, fps: 5, q: 12 }
  ];

  for (const p of presets) {
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath,
      '-t', String(FORCE_VIDEO_SEC),
      '-vf', `scale=${p.size}:${p.size}:force_original_aspect_ratio=decrease:flags=lanczos,fps=${p.fps},format=rgba,pad=${p.size}:${p.size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
      '-vcodec', 'libwebp',
      '-q:v', String(p.q),
      '-compression_level', '6',
      '-loop', '0',
      '-an',
      outputPath
    ], { timeout: 120000 });

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size <= MAX_WEBP_BYTES) {
      return p.size;
    }
  }
  return 128;
}

async function buildStaticWebp(inputPath, outputPath) {
  await execFileAsync('ffmpeg', [
    '-y', '-i', inputPath,
    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
    '-vcodec', 'libwebp',
    '-q:v', '65',
    '-preset', 'picture',
    '-loop', '0',
    outputPath
  ], { timeout: 60000 });
  return 512;
}

async function extractFullOggOpus(inputPath, outputPath) {
  await execFileAsync('ffmpeg', [
    '-y', '-i', inputPath,
    '-vn', '-map', '0:a:0',
    '-af', 'aresample=async=1:first_pts=0',
    '-c:a', 'libopus',
    '-b:a', '32k',
    '-ar', '48000',
    '-ac', '1',
    '-f', 'ogg',
    outputPath
  ], { timeout: 120000 });
}

module.exports = {
  name: 's2',
  aliases: ['saudio2', 'stk2'],
  category: 'convertidores',
  desc: 'Crea stickers con sonido forzados a 10 segundos + audio completo (o cambia el audio de un sticker)',

  execute: async ({ sock, msg, remoteJid, sender, args, reply }) => {
    const tempFiles = [];

    try {
      patchProtoForSoundStickers();

      const lowerArgs = args.map(a => a.toLowerCase());
      const useWrapper = lowerArgs.includes('wrap') || lowerArgs.includes('v2');
      const isFijar = lowerArgs[0] === 'fijar' || lowerArgs[0] === 'audio';

      const targetMsg = getQuotedMessage(msg) || unwrapMessage(msg.message);
      const info = getMediaInfo(targetMsg);

      // 🎙️ Fijar audio para aplicarlo a sticker, foto o video
      if (isFijar) {
        if (!info || (info.kind !== 'audio' && info.kind !== 'video' && info.kind !== 'sticker')) {
          return reply('❌ Responde a una *nota de voz*, *audio*, *video* o *sticker con sonido* usando *.s2 fijar*.');
        }

        const id = `${Date.now()}_${Math.floor(Math.random() * 9999)}`;
        const oggOut = path.join(TEMP_DIR, `s2_fix_out_${id}.ogg`);

        if (info.kind === 'sticker') {
          const stkAudio = info.media?.audioMessage;
          if (!stkAudio?.mediaKey) return reply('❌ Ese sticker no tiene audio para extraer.');
          fs.writeFileSync(oggOut, await downloadMedia(stkAudio, 'audio'));
        } else {
          const rawIn = path.join(TEMP_DIR, `s2_fix_in_${id}.${info.kind === 'video' ? 'mp4' : 'ogg'}`);
          tempFiles.push(rawIn);
          fs.writeFileSync(rawIn, await downloadMedia(info.media, info.downloadType));

          const probe = await probeMedia(rawIn);
          if (!probe.hasAudio) return reply('❌ Ese archivo no contiene audio.');
          await extractFullOggOpus(rawIn, oggOut);
        }

        const outProbe = await probeMedia(oggOut);
        const fullSeconds = Math.max(1, Math.round(outProbe.duration || 1));

        const prev = pendingAudios.get(sender);
        if (prev?.path && fs.existsSync(prev.path)) {
          try { fs.unlinkSync(prev.path); } catch {}
        }

        pendingAudios.set(sender, {
          path: oggOut,
          seconds: fullSeconds,
          expiresAt: Date.now() + 3 * 60 * 1000
        });

        return reply(`🎙️ *Audio completo fijado (${fullSeconds}s).* Ahora responde a un *sticker*, *foto* o *video* con *.s2* para ponerle este sonido.`);
      }

      if (!info || (info.kind !== 'video' && info.kind !== 'image' && info.kind !== 'sticker')) {
        return reply(
          `🔊 *STICKER CON AUDIO 10 SEGUNDOS (.s2)* 🔊\n\n` +
          `📹 *Desde un video:*\nEnvía o responde a un video con *.s2* (animación forzada a 10s + audio completo).\n\n` +
          `🧩 *Poner o cambiar audio a un sticker:*\n` +
          `1. Responde a un audio/video con *.s2 fijar*\n` +
          `2. Responde directo al *sticker* con *.s2*`
        );
      }

      let pending = pendingAudios.get(sender);
      if (pending && (Date.now() > pending.expiresAt || !fs.existsSync(pending.path))) {
        pendingAudios.delete(sender);
        pending = null;
      }

      const id = `${Date.now()}_${Math.floor(Math.random() * 9999)}`;
      let webpBuffer = null;
      let audioBuffer = null;
      let audioSeconds = FORCE_VIDEO_SEC;
      let isAnimated = false;
      let width = 512;
      let height = 512;

      if (info.kind === 'sticker') {
        if (!pending) {
          return reply('❌ Primero fija un audio con *.s2 fijar* y luego responde a este sticker con *.s2*.');
        }

        const rawStkPath = path.join(TEMP_DIR, `s2_stk_orig_${id}.webp`);
        tempFiles.push(rawStkPath);

        webpBuffer = await downloadMedia(info.media, 'sticker');
        fs.writeFileSync(rawStkPath, webpBuffer);

        const meta = await inspectExistingWebp(rawStkPath, info.media);
        width = meta.width;
        height = meta.height;
        isAnimated = meta.isAnimated;

        audioBuffer = fs.readFileSync(pending.path);
        audioSeconds = pending.seconds;
        try { fs.unlinkSync(pending.path); } catch {}
        pendingAudios.delete(sender);

      } else if (info.kind === 'video') {
        isAnimated = true;
        const inputPath = path.join(TEMP_DIR, `s2_in_${id}.mp4`);
        const rawWebp = path.join(TEMP_DIR, `s2_raw_${id}.webp`);
        const exifPath = path.join(TEMP_DIR, `s2_exif_${id}.exif`);
        const finalWebp = path.join(TEMP_DIR, `s2_final_${id}.webp`);
        const audioOgg = path.join(TEMP_DIR, `s2_aud_${id}.ogg`);
        tempFiles.push(inputPath, rawWebp, exifPath, finalWebp, audioOgg);

        fs.writeFileSync(inputPath, await downloadMedia(info.media, info.downloadType));

        if (pending) {
          audioBuffer = fs.readFileSync(pending.path);
          audioSeconds = pending.seconds;
          try { fs.unlinkSync(pending.path); } catch {}
          pendingAudios.delete(sender);
        } else {
          const probe = await probeMedia(inputPath);
          if (!probe.hasAudio) {
            return reply('❌ Ese video no tiene audio. Usa uno con sonido o fija uno primero con *.s2 fijar*.');
          }
          await extractFullOggOpus(inputPath, audioOgg);
          audioBuffer = fs.readFileSync(audioOgg);
          const audProbe = await probeMedia(audioOgg);
          audioSeconds = Math.max(1, Math.round(audProbe.duration || 1));
        }

        const dim = await buildAnimatedWebp10s(inputPath, rawWebp);
        width = dim;
        height = dim;

        fs.writeFileSync(exifPath, createExif());
        await execFileAsync('webpmux', ['-set', 'exif', exifPath, rawWebp, '-o', finalWebp]);
        webpBuffer = fs.readFileSync(finalWebp);

      } else {
        if (!pending) {
          return reply('❌ Una foto no tiene audio. Responde primero a un audio con *.s2 fijar* y luego a esta foto con *.s2*.');
        }

        const inputPath = path.join(TEMP_DIR, `s2_in_${id}.jpg`);
        const rawWebp = path.join(TEMP_DIR, `s2_raw_${id}.webp`);
        const exifPath = path.join(TEMP_DIR, `s2_exif_${id}.exif`);
        const finalWebp = path.join(TEMP_DIR, `s2_final_${id}.webp`);
        tempFiles.push(inputPath, rawWebp, exifPath, finalWebp);

        fs.writeFileSync(inputPath, await downloadMedia(info.media, info.downloadType));

        audioBuffer = fs.readFileSync(pending.path);
        audioSeconds = pending.seconds;
        try { fs.unlinkSync(pending.path); } catch {}
        pendingAudios.delete(sender);

        const dim = await buildStaticWebp(inputPath, rawWebp);
        width = dim;
        height = dim;

        fs.writeFileSync(exifPath, createExif());
        await execFileAsync('webpmux', ['-set', 'exif', exifPath, rawWebp, '-o', finalWebp]);
        webpBuffer = fs.readFileSync(finalWebp);
      }

      const [stickerUpload, audioUpload] = await Promise.all([
        prepareWAMessageMedia({ sticker: webpBuffer }, { upload: sock.waUploadToServer }),
        prepareWAMessageMedia(
          { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: false },
          { upload: sock.waUploadToServer }
        )
      ]);

      const audioMsgObj = {
        ...audioUpload.audioMessage,
        seconds: audioSeconds,
        ptt: false,
        mimetype: 'audio/ogg; codecs=opus'
      };

      const stickerMsgObj = {
        ...stickerUpload.stickerMessage,
        mimetype: 'image/webp',
        width,
        height,
        isAnimated,
        isAvatar: false,
        isAiSticker: false,
        isLottie: false,
        stickerSentTs: Date.now(),
        audioMessage: audioMsgObj
      };

      const payload = useWrapper
        ? { audioStickerMessage: { message: { stickerMessage: stickerMsgObj } } }
        : { stickerMessage: stickerMsgObj };

      const waMsg = generateWAMessageFromContent(remoteJid, payload, {
        userJid: sock.user.id,
        quoted: useWrapper ? undefined : msg
      });

      await sock.relayMessage(remoteJid, waMsg.message, { messageId: waMsg.key.id });

    } catch (err) {
      console.log('❌ Error en s2.js:', err?.message || err);
      return reply('❌ Ocurrió un error al crear el sticker con audio.');
    } finally {
      tempFiles.forEach(file => {
        try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch {}
      });
    }
  }
};
