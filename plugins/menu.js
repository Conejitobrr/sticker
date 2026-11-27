'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'menu',
  aliases: ['help', 'ayuda', 'comandos'],
  category: 'utilidad',
  desc: 'Muestra el menú de comandos del bot',

  execute: async ({ sock, msg, remoteJid, pushName, config, isOwner, reply }) => {
    try {
      const PLUGINS_DIR = path.join(process.cwd(), 'plugins');
      const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));
      const cats = {};

      for (const file of files) {
        try {
          const plugin = require(path.join(PLUGINS_DIR, file));
          if (!plugin.name || typeof plugin.execute !== 'function') continue;
          const cat = (plugin.category || 'GENERAL').toUpperCase();
          if (cat === 'OWNER' && !isOwner) continue;
          if (!cats[cat]) cats[cat] = [];
          cats[cat].push({
            name: plugin.name,
            aliases: Array.isArray(plugin.aliases) ? plugin.aliases : [],
            desc: plugin.desc || ''
          });
        } catch {}
      }

      const pref = Array.isArray(config.prefix) ? config.prefix[0] : config.prefix;
      let txt = `╔══════════════════════╗\n`;
      txt += `     🤖 *${config.botName.toUpperCase()}*\n`;
      txt += `╚══════════════════════╝\n\n`;
      txt += `👤 Hola *${pushName}* ✨\n`;
      txt += `⚙️ Prefijos: *${Array.isArray(config.prefix) ? config.prefix.join(' ') : config.prefix}*\n`;
      txt += `🛡️ Protección Anti-Ban: *Activa*\n\n`;

      for (const cat of Object.keys(cats).sort()) {
        txt += `━━━━━━━━━━━━━━━━━━━\n`;
        txt += `📌 *${cat}*\n`;
        txt += `━━━━━━━━━━━━━━━━━━━\n`;
        for (const c of cats[cat]) {
          txt += `✦ *${pref}${c.name}*${c.aliases.length ? ` _(${c.aliases.join(', ')})_` : ''}\n`;
          if (c.desc) txt += `  ╰ ◦ _${c.desc}_\n`;
        }
        txt += `\n`;
      }

      txt += `⚡ _Usa *${pref}ping* para verificar estado y mensajes procesados._`;
      await sock.sendMessage(remoteJid, { text: txt.trim() }, { quoted: msg });
    } catch (err) {
      return reply('❌ Error generando el menú.');
    }
  }
};
