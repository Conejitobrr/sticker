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

module.exports = {
  name: 'tomp3',
  aliases: ['toaudio', 'mp3', 'tovoz', 'toptt', 'nota'],
  category: 'convertidores',
  desc: 'Extrae el audio en MP3 de un video o lo convierte en nota de voz',

  execute: async ({ sock, msg, remoteJid, commandName, reply }) => {
    let inPath = null;
    let outPath = null;
    try {
      const m = unwrapMessage(msg.message);
      const ctx = m.extendedTextMessage?.contextInfo;
      const target = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : m;

      const isVideo = !!target.videoMessage;
      const isAudio = !!target.audioMessage;
      if (!isVideo && !isAudio) {
        return reply('❌ Responde a un *video* o *audio* con *.tomp3* o *.tovoz*.');
      }

      const stream = await downloadContentFromMessage(isVideo ? target.videoMessage : target.audioMessage, isVideo ? 'video' : 'audio');
      const chunks = [];
      for await (const c of stream) chunks.push(c);

      const id = `${Date.now()}_${Math.floor(Math.random() * 9999)}`;
      const toVoice = ['tovoz', 'toptt', 'nota'].includes(commandName.toLowerCase());
      inPath = path.join(TEMP_DIR, `aud_in_${id}.${isVideo ? 'mp4' : 'ogg'}`);
      outPath = path.join(TEMP_DIR, `aud_out_${id}.${toVoice ? 'ogg' : 'mp3'}`);
      fs.writeFileSync(inPath, Buffer.concat(chunks));

      const ffArgs = toVoice
        ? ['-y', '-i', inPath, '-vn', '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', '-f', 'ogg', outPath]
        : ['-y', '-i', inPath, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', outPath];

      await execFileAsync('ffmpeg', ffArgs, { timeout: 90000 });

      if (toVoice) {
        await sock.sendMessage(remoteJid, { audio: fs.readFileSync(outPath), mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
      } else {
        await sock.sendMessage(remoteJid, { audio: fs.readFileSync(outPath), mimetype: 'audio/mpeg', fileName: `audio_${id}.mp3` }, { quoted: msg });
      }
    } catch (err) {
      console.log('❌ Error en tomp3.js:', err?.message || err);
      return reply('❌ Error al convertir el audio.');
    } finally {
      [inPath, outPath].forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
    }
  }
};
