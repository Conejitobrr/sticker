'use strict';

const path = require('path');
const { spawn } = require('child_process');

module.exports = {
  name: 'reiniciar',
  aliases: ['restart', 'reboot'],
  category: 'owner',
  desc: 'Reinicia por completo el proceso del bot de forma segura',

  execute: async ({ sock, isOwner, reply }) => {
    if (!isOwner) return reply('❌ Solo un Owner puede reiniciar el bot.');

    try {
      await reply('🔄 *Reiniciando bot...*\nEspera unos 5 segundos y prueba con *.ping*.');

      // Cerramos la conexión actual antes de abrir el nuevo proceso
      try { sock.ws?.close(); } catch {}

      setTimeout(() => {
        const entry = path.join(process.cwd(), 'index.js');
        const child = spawn(process.execPath, [entry], {
          cwd: process.cwd(),
          detached: true,
          stdio: 'inherit',
          env: process.env
        });
        child.unref();
        process.exit(0);
      }, 1500);
    } catch (err) {
      console.log('❌ Error en reiniciar.js:', err?.message || err);
      return reply('❌ No se pudo reiniciar el bot automáticamente.');
    }
  }
};
