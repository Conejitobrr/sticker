'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function cleanNumber(jid = '') {
  return String(jid).split(':')[0].split('@')[0].replace(/\D/g, '');
}

// 🔒 Elimina cualquier enlace, usuario de GitHub o referencia al repositorio
function sanitizeGitOutput(text = '') {
  return String(text || '')
    .split('\n')
    .filter(line => !/^\s*(From\s+|remote:|Fetching|->\s+origin\/)/i.test(line))
    .map(line =>
      line
        .replace(/https?:\/\/[^\s'"`]+/gi, '[privado]')
        .replace(/git@[^\s'"`]+/gi, '[privado]')
        .replace(/[a-z0-9.-]*github\.com[^\s'"`]*/gi, '[privado]')
        .replace(/[a-z0-9.-]*gitlab\.com[^\s'"`]*/gi, '[privado]')
        .replace(/origin\/[^\s]+/gi, 'servidor')
        .replace(/\b[\w.-]+\.git\b/gi, '[privado]')
    )
    .filter(line => line.trim().length > 0)
    .join('\n')
    .trim();
}

module.exports = {
  name: 'update',
  aliases: ['actualizar', 'pull'],
  category: 'owner',
  desc: 'Actualiza el bot de forma privada (Solo Owner)',

  execute: async ({ msg, sender, config, isOwner, reloadPlugins, reply }) => {
    // 🛡️ Doble validación estricta de Owner
    const senderNum = cleanNumber(sender);
    const ownerList = Array.isArray(config?.owner) ? config.owner.map(n => String(n).replace(/\D/g, '')) : [];
    const verifiedOwner = Boolean(isOwner) || Boolean(msg?.key?.fromMe) || ownerList.includes(senderNum);

    if (!verifiedOwner) {
      return reply('❌ Este comando es exclusivo de los *Owners* del bot.');
    }

    try {
      await reply('🔄 Verificando actualizaciones privadas...');

      const { stdout, stderr } = await execFileAsync('git', ['pull', '--no-rebase'], {
        cwd: process.cwd(),
        timeout: 60000
      });

      const rawCombined = `${stdout || ''}\n${stderr || ''}`;

      if (/Already up to date|Ya está actualizado/i.test(rawCombined)) {
        if (typeof reloadPlugins === 'function') reloadPlugins();
        return reply('✅ El bot ya está en su última versión.\n♻️ Plugins recargados en memoria.');
      }

      // Obtenemos únicamente los nombres de archivos cambiados (sin URL ni commits remotos)
      let changedFiles = '';
      try {
        const diff = await execFileAsync('git', ['diff', '--name-only', 'ORIG_HEAD', 'HEAD'], {
          cwd: process.cwd(),
          timeout: 15000
        });
        changedFiles = (diff.stdout || '').trim();
      } catch {}

      const cleanSummary = changedFiles
        ? changedFiles.split('\n').map(f => `• ${f.trim()}`).join('\n')
        : sanitizeGitOutput(stdout) || 'Cambios aplicados correctamente.';

      const needsCoreRestart = /(index\.js|main\.js|handler\.js|config\.js|package\.json|lib\/)/i.test(changedFiles || rawCombined);

      if (typeof reloadPlugins === 'function') {
        reloadPlugins();
      }

      let response = `✅ *Actualización completada*\n\n📁 *Archivos actualizados:*\n${cleanSummary.slice(0, 1000)}\n\n`;
      response += needsCoreRestart
        ? '⚠️ Se actualizaron archivos del núcleo. Usa *.reiniciar* para aplicar los cambios.'
        : '♻️ Plugins recargados al instante sin reiniciar el bot.';

      return reply(response);

    } catch (err) {
      // Log completo solo en tu consola privada de Termux
      console.log('❌ Error en update.js:', err?.stderr || err?.message || err);
      // En WhatsApp nunca se muestra ningún enlace ni detalle del repositorio
      const safeErr = sanitizeGitOutput(err?.stderr || err?.message || 'No se pudo completar la actualización.');
      return reply(`❌ Error al actualizar:\n\`\`\`${safeErr.slice(0, 350)}\`\`\``);
    }
  }
};
