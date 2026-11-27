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
  name: 'volumen',
  aliases: ['vol', 'subirvolumen', 'bajarvolumen'],
  category: 'multimedia',
  desc: 'Sube o baja el volumen de audios, notas de voz o videos (0.2 a 5)',

  execute: async ({ sock, msg, remoteJid, args, commandName, reply }) => {
    const tempFiles = [];
    try {
      const cmd = commandName.toLowerCase();
      let level = parseFloat((args[0] || '').replace(',', '.'));

      if (isNaN(level)) {
        if (cmd === 'subirvolumen') level = 2.0;
        else if (cmd === 'bajarvolumen') level = 0.5;
        else return reply('🔊 Responde a un *audio* o *video* con *.vol [0.2 - 5]*\n📌 Ejemplo: *.vol 2* (doble volumen) o *.vol 0.5* (mitad)');
      }

      if (level < 0.2 || level > 5.0) {
        return reply('❌ Usa un nivel entre *0.2* y *5.0*.');
      }

      const m = unwrapMessage(msg.message);
      const ctx = m.extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
      const target = quoted || m;

      const isVideo = !!target.videoMessage;
      const isAudio = !!target.audioMessage;
      if (!isVideo && !isAudio) {
        return reply('❌ Responde a un *audio*, *nota de voz* o *video*.');
      }

      const stream = await downloadContentFromMessage(isVideo ? target.videoMessage : target.audioMessage, isVideo ? 'video' : 'audio');
      const chunks = [];
      for await (const c of stream) chunks.push(c);

      const id = `${Date.now()}_${Math.floor(Math.random() * 9999)}`;
      const inPath = path.join(TEMP_DIR, `vol_in_${id}.${isVideo ? 'mp4' : 'ogg'}`);
      const outPath = path.join(TEMP_DIR, `vol_out_${id}.${isVideo ? 'mp4' : 'ogg'}`);
      tempFiles.push(inPath, outPath);
      fs.writeFileSync(inPath, Buffer.concat(chunks));

      const ffArgs = isVideo
        ? ['-y', '-i', inPath, '-c:v', 'copy', '-af', `volume=${level}`, '-c:a', 'aac', '-b:a', '128k', outPath]
        : ['-y', '-i', inPath, '-vn', '-af', `volume=${level}`, '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', '-f', 'ogg', outPath];

      await execFileAsync('ffmpeg', ffArgs, { timeout: 120000 });

      if (isVideo) {
        await sock.sendMessage(remoteJid, {
          video: fs.readFileSync(outPath),
          mimetype: 'video/mp4',
          caption: `🔊 Volumen ajustado a *${level}x*`
        }, { quoted: msg });
      } else {
        await sock.sendMessage(remoteJid, {
          audio: fs.readFileSync(outPath),
          mimetype: 'audio/ogg; codecs=opus',
          ptt: !!target.audioMessage.ptt
        }, { quoted: msg });
      }
    } catch (err) {
      console.log('❌ Error en volumen.js:', err?.message || err);
      return reply('❌ Error al ajustar el volumen.');
    } finally {
      tempFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
    }
  }
};
