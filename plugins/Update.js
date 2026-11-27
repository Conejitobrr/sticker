'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

module.exports = {
  name: 'update',
  aliases: ['actualizar', 'pull'],
  category: 'owner',
  desc: 'Descarga cambios de GitHub con git pull y recarga plugins automáticamente',

  execute: async ({ isOwner, reloadPlugins, reply }) => {
    if (!isOwner) return reply('❌ Solo un Owner puede actualizar el bot.');

    try {
      await reply('🔄 Buscando actualizaciones en GitHub...');

      const { stdout, stderr } = await execFileAsync('git', ['pull'], {
        cwd: process.cwd(),
        timeout: 60000
      });

      const out = `${stdout || ''}\n${stderr || ''}`.trim();

      if (/Already up to date|Ya está actualizado/i.test(out)) {
        if (typeof reloadPlugins === 'function') reloadPlugins();
        return reply('✅ El bot ya estaba actualizado.\n♻️ Plugins recargados en memoria.');
      }

      const needsCoreRestart = /(index\.js|main\.js|handler\.js|config\.js|package\.json|lib\/)/i.test(out);

      if (typeof reloadPlugins === 'function') {
        reloadPlugins();
      }

      let msg = `✅ *Actualización descargada:*\n\`\`\`${out.slice(0, 1200)}\`\`\`\n\n`;
      msg += needsCoreRestart
        ? '⚠️ Se modificaron archivos del núcleo. Usa *.reiniciar* para aplicar todos los cambios.'
        : '♻️ Plugins recargados automáticamente sin necesidad de reiniciar.';

      return reply(msg);
    } catch (err) {
      const detail = err?.stderr || err?.message || 'Error desconocido';
      console.log('❌ Error en update.js:', detail);
      return reply(`❌ Falló *git pull*:\n\`\`\`${String(detail).slice(0, 800)}\`\`\``);
    }
  }
};
