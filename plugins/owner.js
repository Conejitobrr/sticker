'use strict';

const fs = require('fs');
const config = require('../config');
const { cleanNumber } = require('../lib/utils');

function loadOwnersFile() {
  try {
    if (!fs.existsSync(config.ownersPath)) return [];
    const data = JSON.parse(fs.readFileSync(config.ownersPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveOwnersFile(list) {
  fs.writeFileSync(config.ownersPath, JSON.stringify(list, null, 2));
}

function resolveTarget(msg, args, participants = []) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const rawJid = ctx?.mentionedJid?.[0] || ctx?.participant || null;

  let num = rawJid ? cleanNumber(rawJid) : (args[0] || '').replace(/\D/g, '');
  if (!num) return null;

  let lid = null;
  let phone = num;

  // Buscar coincidencia en los participantes del grupo para guardar LID + teléfono real
  const match = participants.find(p =>
    cleanNumber(p.id) === num ||
    cleanNumber(p.lid) === num ||
    cleanNumber(p.phoneNumber) === num
  );

  if (match) {
    if (match.id?.endsWith('@lid')) lid = cleanNumber(match.id);
    if (match.lid) lid = cleanNumber(match.lid);
    if (match.phoneNumber) phone = cleanNumber(match.phoneNumber);
    else if (match.id?.endsWith('@s.whatsapp.net')) phone = cleanNumber(match.id);
  } else if (rawJid?.endsWith('@lid')) {
    lid = num;
  }

  return {
    jid: rawJid || `${phone}@s.whatsapp.net`,
    number: phone,
    lid
  };
}

module.exports = {
  name: 'addowner',
  aliases: ['hacerowner', 'delowner', 'quitarowner', 'owners', 'listowner', 'recargar'],
  category: 'owner',
  desc: 'Agrega, quita o lista Owners del bot mencionando o respondiendo a un usuario',

  execute: async ({ sock, msg, remoteJid, args, commandName, isOwner, participants, reloadPlugins, reply }) => {
    if (!isOwner) return reply('❌ Solo un Owner puede usar este comando.');

    const cmd = commandName.toLowerCase();

    // ♻️ Recargar plugins sin apagar el bot (.recargar)
    if (cmd === 'recargar') {
      reloadPlugins();
      return reply('♻️ *Plugins recargados correctamente sin reiniciar el bot.*');
    }

    const saved = loadOwnersFile();

    // 📋 Listar Owners (.owners / .listowner)
    if (cmd === 'owners' || cmd === 'listowner') {
      const lines = [
        `👑 *LISTA DE OWNERS — ${config.botName}*\n`,
        `📌 *Owners fijos (config.js):*`,
        ...config.defaultOwners.map(n => `  • +${n}`),
        `\n📌 *Owners agregados dinámicamente:*`,
        ...(saved.length
          ? saved.map((o, i) => `  ${i + 1}. @${o.number}${o.lid && o.lid !== o.number ? ` _(LID: ${o.lid})_` : ''}`)
          : ['  _(Ninguno todavía)_'])
      ];

      const mentions = saved.map(o => o.jid).filter(Boolean);
      return sock.sendMessage(remoteJid, { text: lines.join('\n'), mentions }, { quoted: msg });
    }

    const target = resolveTarget(msg, args, participants);
    if (!target) {
      return reply('❌ Menciona, responde a una persona o escribe su número.\n📌 Ejemplo: *.addowner @usuario* o *.delowner @usuario*');
    }

    // ➕ Agregar Owner (.addowner / .hacerowner)
    if (cmd === 'addowner' || cmd === 'hacerowner') {
      const exists = saved.some(o =>
        o.number === target.number || (target.lid && o.lid === target.lid)
      );

      if (exists || config.defaultOwners.includes(target.number)) {
        return sock.sendMessage(remoteJid, {
          text: `⚠️ @${cleanNumber(target.jid)} ya es Owner del bot.`,
          mentions: [target.jid]
        }, { quoted: msg });
      }

      saved.push({
        number: target.number,
        lid: target.lid || null,
        jid: target.jid,
        addedAt: Date.now()
      });
      saveOwnersFile(saved);

      return sock.sendMessage(remoteJid, {
        text: `👑 *¡NUEVO OWNER AGREGADO!*\n\n✅ @${cleanNumber(target.jid)} ahora tiene control total del bot (sin cooldown ni restricciones).`,
        mentions: [target.jid]
      }, { quoted: msg });
    }

    // ➖ Quitar Owner (.delowner / .quitarowner)
    if (cmd === 'delowner' || cmd === 'quitarowner') {
      if (config.defaultOwners.includes(target.number)) {
        return reply('⚠️ Ese número está fijo en `config.js`. Quítalo manualmente ahí si deseas removerlo.');
      }

      const before = saved.length;
      const filtered = saved.filter(o =>
        o.number !== target.number && (!target.lid || o.lid !== target.lid)
      );

      if (filtered.length === before) {
        return reply('❌ Ese usuario no está en la lista de Owners agregados.');
      }

      saveOwnersFile(filtered);
      return sock.sendMessage(remoteJid, {
        text: `🗑️ *OWNER REMOVIDO*\n\n@${cleanNumber(target.jid)} ya no tiene permisos de Owner.`,
        mentions: [target.jid]
      }, { quoted: msg });
    }
  }
};
