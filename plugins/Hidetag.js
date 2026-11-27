'use strict';

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { unwrapMessage } = require('../lib/utils');

async function downloadToBuffer(media, type) {
  const stream = await downloadContentFromMessage(media, type);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = {
  name: 'hidetag',
  aliases: ['notify', 'notificar', 'tag', 'todos'],
  category: 'moderación & grupo',
  desc: 'Menciona a todos los miembros del grupo de forma invisible (soporta texto y multimedia)',

  execute: async ({ sock, msg, remoteJid, args, fromGroup, isAdmin, isOwner, participants, reply }) => {
    try {
      if (!fromGroup) return reply('❌ Este comando solo funciona en grupos.');
      if (!isAdmin && !isOwner) return reply('❌ Solo los administradores o el Owner pueden usar *.hidetag*.');

      let groupParticipants = participants;
      if (!Array.isArray(groupParticipants) || !groupParticipants.length) {
        const meta = sock.getCachedGroupMetadata
          ? await sock.getCachedGroupMetadata(remoteJid, true)
          : await sock.groupMetadata(remoteJid);
        groupParticipants = meta?.participants || [];
      }

      const mentions = groupParticipants.map(p => p.id).filter(Boolean);
      const rawText = args.join(' ').trim();

      const m = unwrapMessage(msg.message);
      const ctx = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo;
      const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
      const targetMediaMsg = quoted || m;

      // 📸 Imagen con hidetag
      if (targetMediaMsg.imageMessage) {
        const buf = await downloadToBuffer(targetMediaMsg.imageMessage, 'image');
        const caption = rawText || targetMediaMsg.imageMessage.caption || '';
        return sock.sendMessage(remoteJid, { image: buf, caption, mentions });
      }

      // 🎥 Video con hidetag
      if (targetMediaMsg.videoMessage) {
        const buf = await downloadToBuffer(targetMediaMsg.videoMessage, 'video');
        const caption = rawText || targetMediaMsg.videoMessage.caption || '';
        return sock.sendMessage(remoteJid, { video: buf, caption, mentions });
      }

      // 🧩 Sticker con hidetag
      if (targetMediaMsg.stickerMessage) {
        const buf = await downloadToBuffer(targetMediaMsg.stickerMessage, 'sticker');
        return sock.sendMessage(remoteJid, { sticker: buf, mentions });
      }

      // 🎵 Audio / Nota de voz con hidetag
      if (targetMediaMsg.audioMessage) {
        const buf = await downloadToBuffer(targetMediaMsg.audioMessage, 'audio');
        return sock.sendMessage(remoteJid, {
          audio: buf,
          mimetype: targetMediaMsg.audioMessage.mimetype || 'audio/ogg; codecs=opus',
          ptt: !!targetMediaMsg.audioMessage.ptt,
          mentions
        });
      }

      // 📝 Texto normal o texto citado
      const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
      const finalText = rawText || quotedText;

      if (!finalText) {
        return reply('❌ Escribe un mensaje o responde a uno.\n📌 Ejemplo: *.hidetag Reunión hoy a las 9 PM*');
      }

      await sock.sendMessage(remoteJid, { text: finalText, mentions });

    } catch (err) {
      console.log('❌ Error en hidetag.js:', err?.message || err);
      return reply('❌ Ocurrió un error al enviar el hidetag.');
    }
  }
};
