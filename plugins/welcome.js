'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DEFAULT_PROFILE = path.join(process.cwd(), 'assets', 'Sinperfil.jpg');
const FALLBACK_URL = 'https://telegra.ph/file/24fa902ead26340f3df2c.png';

function cleanJid(jid = '') { return String(jid).split(':')[0]; }
function cleanNumber(jid = '') { return cleanJid(jid).split('@')[0].replace(/\D/g, ''); }

async function getProfileBuffer(sock, userJid, groupJid) {
  try {
    const url = await sock.profilePictureUrl(userJid, 'image');
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
    return Buffer.from(res.data);
  } catch {}

  try {
    if (fs.existsSync(DEFAULT_PROFILE)) return fs.readFileSync(DEFAULT_PROFILE);
  } catch {}

  try {
    const groupUrl = await sock.profilePictureUrl(groupJid, 'image');
    const res = await axios.get(groupUrl, { responseType: 'arraybuffer', timeout: 8000 });
    return Buffer.from(res.data);
  } catch {}

  try {
    const res = await axios.get(FALLBACK_URL, { responseType: 'arraybuffer', timeout: 8000 });
    return Buffer.from(res.data);
  } catch {
    return null;
  }
}

module.exports = {
  name: 'testwelcome',
  aliases: ['probarwelcome', 'welcometest'],
  category: 'moderación & grupo',
  desc: 'Muestra una vista previa de la bienvenida en el grupo',

  execute: async ({ sock, remoteJid, sender, fromGroup, isAdmin, isOwner, groupData, reply }) => {
    if (!fromGroup) return reply('❌ Solo funciona en grupos.');
    if (!isAdmin && !isOwner) return reply('❌ Solo admins u Owner pueden probar la bienvenida.');

    const estado = groupData?.welcome ? '✅ ACTIVADO' : '❌ DESACTIVADO (usa *.on welcome*)';
    await reply(`🧪 *Probando bienvenida...*\n📌 Estado actual: ${estado}`);

    await module.exports.onGroupUpdate({
      sock,
      id: remoteJid,
      participants: [sender],
      action: 'add',
      forceTest: true
    });
  },

  onGroupUpdate: async ({ sock, id, participants, action, db, forceTest = false }) => {
    try {
      if (!id || !id.endsWith('@g.us')) return;

      if (!forceTest) {
        const groupData = await db.getGroup(id);
        if (!groupData || !groupData.welcome) return;
      }

      let groupName = 'el grupo';
      let memberCount = 'varios';
      let groupDesc = '';

      try {
        const metadata = sock.getCachedGroupMetadata
          ? await sock.getCachedGroupMetadata(id, true)
          : await sock.groupMetadata(id);
        groupName = metadata.subject || 'el grupo';
        memberCount = metadata.participants?.length || 'varios';
        groupDesc = metadata.desc ? String(metadata.desc).trim() : '';
      } catch {}

      for (const p of participants) {
        const rawParticipant = typeof p === 'string' ? p : (p?.id || p?.jid || '');
        if (!rawParticipant) continue;

        const userJid = cleanJid(rawParticipant);
        const userNum = cleanNumber(userJid);
        if (!userNum) continue;

        const imgBuffer = await getProfileBuffer(sock, userJid, id);

        if (action === 'add') {
          let texto = `╔══════════════════════╗\n`;
          texto += `      🎉 *¡BIENVENIDO/A!* 🎉\n`;
          texto += `╚══════════════════════╝\n\n`;
          texto += `👋 Hola @${userNum}, bienvenido/a a *${groupName}* ✨\n\n`;
          texto += `👥 *Miembros ahora:* ${memberCount}\n`;
          if (groupDesc) texto += `\n📜 *Descripción / Reglas:*\n${groupDesc.slice(0, 300)}\n`;
          texto += `\n💡 _Usa *.menu* para ver los comandos disponibles._`;

          if (imgBuffer) {
            await sock.sendMessage(id, { image: imgBuffer, caption: texto, mentions: [userJid] });
          } else {
            await sock.sendMessage(id, { text: texto, mentions: [userJid] });
          }
        } else if (action === 'remove') {
          let texto = `╔══════════════════════╗\n`;
          texto += `        👋 *¡ADIÓS!* 👋\n`;
          texto += `╚══════════════════════╝\n\n`;
          texto += `💨 @${userNum} salió de *${groupName}*.\n`;
          texto += `👥 *Quedamos:* ${memberCount} miembros.`;

          if (imgBuffer) {
            await sock.sendMessage(id, { image: imgBuffer, caption: texto, mentions: [userJid] });
          } else {
            await sock.sendMessage(id, { text: texto, mentions: [userJid] });
          }
        }
      }
    } catch (err) {
      console.log('❌ Error en welcome.js:', err?.message || err);
    }
  }
};
