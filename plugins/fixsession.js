'use strict';

module.exports = {
  name: 'fixsession',
  aliases: ['limpiarsesion', 'repararsesion'],
  category: 'owner',
  desc: 'Limpia llaves de cifrado corruptas (sin cerrar sesión) y reconecta el bot',

  execute: async ({ sock, isOwner, reply }) => {
    if (!isOwner) return reply('❌ Solo un Owner puede usar este comando.');

    if (typeof sock.cleanSignalAndReconnect !== 'function') {
      return reply('⚠️ Actualiza primero `main.js` para habilitar la reparación automática.');
    }

    await reply('🩹 *Limpiando llaves Signal corruptas y reconectando...*\nEspera 5 segundos y prueba con *.ping*.');
    setTimeout(() => {
      sock.cleanSignalAndReconnect();
    }, 1200);
  }
};
