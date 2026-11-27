'use strict';

const FEATURES = ['bot', 'welcome'];

module.exports = {
  name: 'config',
  aliases: ['activar', 'desactivar', 'on', 'off', 'enable', 'disable'],
  category: 'moderación & grupo',
  desc: 'Activa o desactiva las bienvenidas o el bot en el grupo',

  execute: async ({ commandName, args, isOwner, isAdmin, fromGroup, groupData, db, remoteJid, reply }) => {
    if (!fromGroup) return reply('❌ Comando solo para grupos.');

    const feature = (args[0] || '').toLowerCase();
    if (!feature || !FEATURES.includes(feature)) {
      return reply(
        `⚙️ *CONFIGURACIÓN DEL GRUPO*\n\n` +
        `📌 *Opciones válidas:*\n` +
        `➤ *welcome* _(Bienvenidas y despedidas con foto)_\n` +
        `➤ *bot* _(Encender/apagar bot en este grupo)_\n\n` +
        `💡 *Ejemplo:* *.on welcome* o *.off welcome*`
      );
    }

    if (!isOwner && (!isAdmin || feature !== 'welcome')) {
      return reply('❌ Solo un Administrador (para welcome) o el Owner pueden cambiar esta opción.');
    }

    const action = ['activar', 'on', 'enable'].includes(commandName.toLowerCase());
    if (groupData[feature] === action) {
      return reply(`⚠️ La opción *${feature}* ya estaba ${action ? 'ACTIVADA' : 'DESACTIVADA'}.`);
    }

    groupData[feature] = action;
    if (groupData.save) await groupData.save();
    else await db.setGroup(remoteJid, groupData);

    return reply(`✅ Opción *${feature}* ${action ? 'ACTIVADA' : 'DESACTIVADA'} correctamente.`);
  }
};
