'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const yts = require('yt-search');

const execFileAsync = promisify(execFile);
const TEMP_DIR = path.join(process.cwd(), 'temp');
const MAX_MB = 45;

function ensureTemp() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function findDownloadedFile(prefix) {
  const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(prefix) && !f.endsWith('.part'));
  return files.length ? path.join(TEMP_DIR, files[0]) : null;
}

function cleanByPrefix(prefix) {
  try {
    for (const f of fs.readdirSync(TEMP_DIR)) {
      if (f.startsWith(prefix)) fs.unlinkSync(path.join(TEMP_DIR, f));
    }
  } catch {}
}

module.exports = {
  name: 'play',
  aliases: ['yt', 'musica', 'video', 'ytmp4', 'tiktok', 'tt', 'instagram', 'ig', 'facebook', 'fb'],
  category: 'descargas',
  desc: 'Descarga música y videos de YouTube, TikTok, Instagram y Facebook',

  execute: async ({ sock, msg, remoteJid, args, commandName, reply }) => {
    ensureTemp();
    const cmd = commandName.toLowerCase();
    const query = args.join(' ').trim();
    const id = `dl_${Date.now()}_${Math.floor(Math.random() * 9999)}`;

    if (!query) {
      return reply(
        `📥 *DESCARGAS MULTIMEDIA*\n\n` +
        `🎵 *.play [nombre o link]* — Música de YouTube\n` +
        `🎥 *.video [nombre o link]* — Video de YouTube (480p)\n` +
        `📱 *.tiktok [link]* — Video de TikTok\n` +
        `📸 *.instagram [link]* — Reel/Video de Instagram\n` +
        `📘 *.facebook [link]* — Video de Facebook`
      );
    }

    try {
      await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

      // 🎵 YOUTUBE AUDIO (.play / .yt / .musica)
      if (['play', 'yt', 'musica'].includes(cmd)) {
        let targetUrl = query;
        let title = 'Audio de YouTube';
        let duration = '';

        if (!/^https?:\/\//i.test(query)) {
          const search = await yts(query);
          const first = search?.videos?.[0];
          if (!first) return reply('❌ No encontré esa canción en YouTube.');
          targetUrl = first.url;
          title = first.title;
          duration = first.timestamp ? ` (${first.timestamp})` : '';
        }

        const outTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);
        await execFileAsync('yt-dlp', [
          '-x', '--audio-format', 'mp3',
          '--audio-quality', '128K',
          '--max-filesize', `${MAX_MB}M`,
          '--no-playlist',
          '-o', outTemplate,
          targetUrl
        ], { timeout: 180000 });

        const outFile = findDownloadedFile(id);
        if (!outFile) return reply('❌ No se pudo descargar el audio (puede superar 45 MB).');

        await sock.sendMessage(remoteJid, {
          audio: fs.readFileSync(outFile),
          mimetype: 'audio/mpeg',
          fileName: `${title.replace(/[^\w\s-]/g, '').slice(0, 50)}.mp3`
        }, { quoted: msg });

        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
        return;
      }

      // 🎥 YOUTUBE VIDEO (.video / .ytmp4)
      if (['video', 'ytmp4'].includes(cmd)) {
        let targetUrl = query;
        let title = 'Video de YouTube';

        if (!/^https?:\/\//i.test(query)) {
          const search = await yts(query);
          const first = search?.videos?.[0];
          if (!first) return reply('❌ No encontré ese video en YouTube.');
          targetUrl = first.url;
          title = first.title;
        }

        const outTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);
        await execFileAsync('yt-dlp', [
          '-f', 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]',
          '--merge-output-format', 'mp4',
          '--max-filesize', `${MAX_MB}M`,
          '--no-playlist',
          '-o', outTemplate,
          targetUrl
        ], { timeout: 240000 });

        const outFile = findDownloadedFile(id);
        if (!outFile) return reply('❌ No se pudo descargar el video (o supera 45 MB).');

        await sock.sendMessage(remoteJid, {
          video: fs.readFileSync(outFile),
          mimetype: 'video/mp4',
          caption: `🎥 *${title}*`
        }, { quoted: msg });

        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
        return;
      }

      // 📱 TIKTOK / INSTAGRAM / FACEBOOK
      if (!/^https?:\/\//i.test(query)) {
        return reply(`❌ Pega un enlace válido para *.${cmd}*.`);
      }

      const outTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);
      await execFileAsync('yt-dlp', [
        '-f', 'best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--max-filesize', `${MAX_MB}M`,
        '--no-playlist',
        '-o', outTemplate,
        query
      ], { timeout: 180000 });

      const outFile = findDownloadedFile(id);
      if (!outFile) return reply('❌ No se pudo descargar ese enlace (verifica que sea público y menor a 45 MB).');

      await sock.sendMessage(remoteJid, {
        video: fs.readFileSync(outFile),
        mimetype: 'video/mp4',
        caption: `📥 *Descargado por Sirius MediaBot*`
      }, { quoted: msg });

      await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });

    } catch (err) {
      console.log(`❌ Error en descarga (${cmd}):`, err?.message || err);
      return reply('❌ Error al descargar. Verifica el enlace o intenta con otro video.');
    } finally {
      cleanByPrefix(id);
    }
  }
};
