'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const OWNERS_PATH = path.resolve(process.cwd(), 'lib', 'owners.json');

// 👤 Pon aquí tu número personal de WhatsApp (con código de país, sin +)
const defaultOwners = [
  '51958959882',
  '42696337031354',
  '132482980696170'
];

function loadDynamicOwners() {
  try {
    if (!fs.existsSync(OWNERS_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(OWNERS_PATH, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.flatMap(entry => {
      if (typeof entry === 'string') return [entry.replace(/\D/g, '')];
      if (entry && typeof entry === 'object') {
        return [entry.number, entry.lid].filter(Boolean).map(v => String(v).replace(/\D/g, ''));
      }
      return [];
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function getAllOwners() {
  const envOwners = process.env.OWNERS
    ? process.env.OWNERS.split(',').map(n => n.replace(/\D/g, '')).filter(Boolean)
    : [];
  return [...new Set([...defaultOwners, ...envOwners, ...loadDynamicOwners()])];
}

module.exports = {
  get owner() {
    return getAllOwners();
  },
  defaultOwners,
  ownersPath: OWNERS_PATH,

  // 🤖 IDENTIDAD DEL BOT
  botName: process.env.BOT_NAME || 'Sirius MediaBot',
  botVersion: '1.0.0',
  footer: 'Sirius MediaBot • Anti-Ban',

  // ⚙️ PREFIJOS
  prefix: ['.', '!', '#', '/'],

  // 🔌 CONEXIÓN
  sessionPath: './session',
  autoReconnect: true,
  debug: true,

  // 🛡️ ESCUDO ANTI-BAN Y ANTI-OVERLIMIT
  antiBan: {
    minSendDelayMs: 1200,        // Pausa mínima humana entre envíos (1.2s)
    maxSendDelayMs: 2200,        // Pausa máxima aleatoria (2.2s)
    maxOutgoingPerMinute: 18,    // Tope global de envíos por minuto (evita suspensión)
    userCooldownMs: 4000,        // Espera entre comandos por usuario normal (4s)
    groupMaxCmdsPer20s: 6,       // Máx. comandos en un grupo cada 20s (anti-flood)
    simulateTyping: true,        // Simula "escribiendo..." brevemente antes de responder
    overlimitPauseMs: 15000      // Pausa de enfriamiento si WhatsApp reporta rate-overlimit
  }
};
