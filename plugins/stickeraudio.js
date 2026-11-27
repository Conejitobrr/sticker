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
const MAX_VIDEO_SEC = 6; // Máximo estable para animación WebP en WhatsApp

// Memoria temporal para combinar un audio + foto/video (.saudio fijar)
const pendingAudios = new Map();

// 🔧 PARCHE EN MEMORIA PARA BAILEYS v6.7.x (Agrega campos nativos de Sound Stickers 2026)
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
        // Campo 26 (oneof audio) -> (26 << 3) | 2 = 210
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
        // Campo 134 (FutureProofMessage) -> (134 << 3) | 2 = 1074
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
    m.documentMessage?.contextInfo;
  return context?.quotedMessage ? unwrapMessage(context.quotedMessage) : null;
}

function getMediaInfo(message) {
  if (!message) return null;
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
    'sticker-pack-id': 'com.siriusbot.soundsticker',
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
    return { hasAudio: true, duration: 6 };
  }
}

async function buildAnimatedWebp(inputPath, outputPath, maxSec = MAX_VIDEO_SEC) {
  // Ajusta resolución/fps progresivamente para que los 6s quepan bajo el límite de ~500KB de WhatsApp
  const presets = [
    { size: 320, fps: 12, q: 52 },
    { size: 256, fps: 10, q: 45 },
    { size: 240, fps: 9, q: 38 },
    { size: 200, fps: 8, q: 30 },
    { size: 180, fps: 7, q: 25 }
  ];

  for (const p of presets) {
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath,
      '-t', String(maxSec),
      '-vf', `scale=${p.size}:${p.size}:force_original_aspect_ratio=decrease:flags=lanczos,fps=${p.fps},format=rgba,pad=${p.size}:${p.size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
      '-vcodec', 'libwebp',
      '-q:v', String(p.q),
      '-compression_level', '4',
      '-loop', '0',
      '-an',
      outputPath
    ], { timeout: 90000 });

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size <= 490 * 1024) {
      return p.size;
    }
  }
  return 180;
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

// 🎵 Extrae el audio COMPLETO sin recortarlo a 6 segundos
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
  name: 'saudio',
  aliases: ['stickeraudio', 'sa', 'sconaudio'],
  category: 'convertidores',
  desc: 'Convierte un video (animación 6s + audio completo) o foto + audio en sticker nativo con sonido',

  execute: async ({ sock, msg, remoteJid, sender, args, reply }) => {
    const tempFiles = [];

    try {
      patchProtoForSoundStickers();

      const lowerArgs = args.map(a => a.toLowerCase());
      const useWrapper = lowerArgs.includes('wrap') || lowerArgs.includes('v2');
      const isFijar = lowerArgs[0] === 'fijar' || lowerArgs[0] === 'audio';

      const targetMsg = getQuotedMessage(msg) || unwrapMessage(msg.message);
      const info = getMediaInfo(targetMsg);

      // 🎙️ MODO OPCIONAL: Fijar un audio completo para pegárselo a una foto o video (.saudio fijar)
      if (isFijar) {
        if (!info || (info.kind !== 'audio' && info.kind !== 'video')) {
          return reply('❌ Responde a una nota de voz, audio o video con *.saudio fijar*.');
        }

        const id = `${Date.now()}_${Math.floor(Math.random() * 9999)}`;
        const rawIn = path.join(TEMP_DIR, `sa_fix_in_${id}.${info.kind === 'video' ? 'mp4' : 'ogg'}`);
        const oggOut = path.join(TEMP_DIR, `sa_fix_out_${id}.ogg`);
        tempFiles.push(rawIn);

        fs.writeFileSync(rawIn, await downloadMedia(info.media, info.downloadType));
        const probe = await probeMedia(rawIn);
        if (!probe.hasAudio) return reply('❌ Ese archivo no contiene audio.');

        await extractFullOggOpus(rawIn, oggOut);
        const outProbe = await probeMedia(oggOut);

        const prev = pendingAudios.get(sender);
        if (prev?.path && fs.existsSync(prev.path)) {
          try { fs.unlinkSync(prev.path); } catch {}
        }

        const fullSeconds = Math.max(1, Math.round(outProbe.duration || 1));
        pendingAudios.set(sender, {
          path: oggOut,
          seconds: fullSeconds,
          expiresAt: Date.now() + 2 * 60 * 1000
        });

        return reply(`🎙️ *Audio completo fijado (${fullSeconds}s).* Ahora responde a una *imagen* o *video* con *.saudio* para unirlos.`);
      }

      if (!info || (info.kind !== 'video' && info.kind !== 'image')) {
        return reply(
          `🔊 *STICKER NATIVO CON AUDIO* 🔊\n\n` +
          `📹 *Desde un video:*\nEnvía o responde a un video con *.saudio* (animación de hasta 6s en bucle + audio completo).\n\n` +
          `🖼️ *Desde una foto/video + audio aparte:*\n1. Responde a un audio con *.saudio fijar*\n2. Responde a una foto o video con *.saudio*`
        );
      }

      // Revisar si el usuario tiene un audio fijado vigente
      let pending = pendingAudios.get(sender);
      if (pending && (Date.now() > pending.expiresAt || !fs.existsSync(pending.path))) {
        pendingAudios.delete(sender);
        pending = null;
      }

      const id = `${Date.now()}_${Math.floor(Math.random() * 9999)}`;
      const inExt = info.kind === 'video' ? 'mp4' : 'jpg';
      const inputPath = path.join(TEMP_DIR, `sa_in_${id}.${inExt}`);
      const rawWebp = path.join(TEMP_DIR, `sa_raw_${id}.webp`);
      const exifPath = path.join(TEMP_DIR, `sa_exif_${id}.exif`);
      const finalWebp = path.join(TEMP_DIR, `sa_final_${id}.webp`);
      const audioOgg = path.join(TEMP_DIR, `sa_aud_${id}.ogg`);

      tempFiles.push(inputPath, rawWebp, exifPath, finalWebp, audioOgg);

      const mediaBuffer = await downloadMedia(info.media, info.downloadType);
      fs.writeFileSync(inputPath, mediaBuffer);

      let audioBuffer = null;
      let audioSeconds = 6;
      let isAnimated = false;
      let dim = 512;

      if (info.kind === 'video') {
        isAnimated = true;

        if (pending) {
          // Usa la duración COMPLETA del audio fijado, sin recortarlo a 6s
          audioBuffer = fs.readFileSync(pending.path);
          audioSeconds = pending.seconds;
          try { fs.unlinkSync(pending.path); } catch {}
          pendingAudios.delete(sender);
        } else {
          const probe = await probeMedia(inputPath);
          if (!probe.hasAudio) {
            return reply('❌ Ese video no tiene sonido. Usa uno con audio o fija uno primero con *.saudio fijar*.');
          }
          // Extrae toda la música/audio del video sin cortar
          await extractFullOggOpus(inputPath, audioOgg);
          audioBuffer = fs.readFileSync(audioOgg);
          const audProbe = await probeMedia(audioOgg);
          audioSeconds = Math.max(1, Math.round(audProbe.duration || 1));
        }

        // Recorta únicamente el video animado a 6 segundos (en bucle)
        dim = await buildAnimatedWebp(inputPath, rawWebp, MAX_VIDEO_SEC);
      } else {
        if (!pending) {
          return reply('❌ Una foto no tiene sonido. Responde primero a una nota de voz con *.saudio fijar* y luego a esta foto con *.saudio*.');
        }
        audioBuffer = fs.readFileSync(pending.path);
        audioSeconds = pending.seconds;
        try { fs.unlinkSync(pending.path); } catch {}
        pendingAudios.delete(sender);

        dim = await buildStaticWebp(inputPath, rawWebp);
      }

      // Inyectar EXIF del pack SiriusBot
      fs.writeFileSync(exifPath, createExif());
      await execFileAsync('webpmux', ['-set', 'exif', exifPath, rawWebp, '-o', finalWebp]);
      const webpBuffer = fs.readFileSync(finalWebp);

      // ☁️ Subir ambos archivos (WebP de 6s + Audio OGG completo) a WhatsApp
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
        width: dim,
        height: dim,
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
      console.log('❌ Error en stickeraudio:', err?.message || err);
      return reply('❌ Ocurrió un error creando el sticker con audio.');
    } finally {
      tempFiles.forEach(file => {
        try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch {}
      });
    }
  }
};
