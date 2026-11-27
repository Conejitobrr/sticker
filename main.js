'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const chalk = require('chalk');
const qrcode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');

const config = require('./config');
const { messageHandler, dispatchGroupUpdate } = require('./handler');

// ⏱️ Hora exacta en que se encendió el proceso: ignora TODO mensaje enviado antes de prender el bot
const BOOT_TIME_SEC = Math.floor(Date.now() / 1000);

// 🧠 Caché de reintentos compatible con Baileys (evita perder mensajes en ráfagas por Bad MAC)
function createSimpleCache(ttlMs = 10 * 60 * 1000) {
  const store = new Map();
  return {
    get(key) {
      const item = store.get(key);
      if (!item) return undefined;
      if (Date.now() > item.exp) {
        store.delete(key);
        return undefined;
      }
      return item.val;
    },
    set(key, val) {
      store.set(key, { val, exp: Date.now() + ttlMs });
      if (store.size > 3000) {
        const firstKey = store.keys().next().value;
        store.delete(firstKey);
      }
    },
    del(key) { store.delete(key); },
    flushAll() { store.clear(); }
  };
}

const msgRetryCounterCache = createSimpleCache(10 * 60 * 1000);

// 📦 Almacén en memoria de mensajes recientes (para getMessage y reintentos)
const messageStore = new Map();
function saveMsgToStore(msg) {
  const id = msg?.key?.id;
  if (!id || !msg?.message) return;
  messageStore.set(id, msg.message);
  if (messageStore.size > 1500) {
    const oldest = messageStore.keys().next().value;
    messageStore.delete(oldest);
  }
}

// 👥 Caché de metadatos de grupo (evita consultar a WhatsApp en cada mensaje)
const groupMetaCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000;

// 📥 COLA SEGURA DE RECEPCIÓN (Verifica cada mensaje y evita perder mensajes en ráfagas de 20+)
const processedIds = new Set();
const incomingQueue = [];
let activeWorkers = 0;
const MAX_CONCURRENT_WORKERS = 3;
const stats = { received: 0, processed: 0, skippedOld: 0, duplicates: 0 };

function markProcessed(id) {
  if (!id) return false;
  if (processedIds.has(id)) return false;
  processedIds.add(id);
  if (processedIds.size > 5000) {
    const first = processedIds.values().next().value;
    processedIds.delete(first);
  }
  return true;
}

function getMsgTimestampSec(msg) {
  const raw = msg?.messageTimestamp;
  if (!raw) return Math.floor(Date.now() / 1000);
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'object' && typeof raw.low === 'number') return raw.low;
  return Number(raw) || Math.floor(Date.now() / 1000);
}

function enqueueIncoming(sock, msg) {
  const id = msg?.key?.id;
  if (!id) return;

  // 1. Verificar duplicados
  if (!markProcessed(id)) {
    stats.duplicates++;
    return;
  }

  // 2. Ignorar mensajes viejos enviados mientras el bot estaba apagado
  const ts = getMsgTimestampSec(msg);
  if (ts < BOOT_TIME_SEC - 3) {
    stats.skippedOld++;
    return;
  }

  stats.received++;
  incomingQueue.push({ sock, msg });
  drainIncomingQueue();
}

function drainIncomingQueue() {
  while (activeWorkers < MAX_CONCURRENT_WORKERS && incomingQueue.length > 0) {
    const item = incomingQueue.shift();
    activeWorkers++;
    Promise.resolve()
      .then(() => messageHandler(item.sock, item.msg, { stats }))
      .catch(err => console.log(chalk.red('❌ Error procesando mensaje en cola:'), err?.message || err))
      .finally(() => {
        stats.processed++;
        activeWorkers--;
        drainIncomingQueue();
      });
  }
}

let reconnectAttempts = 0;
let isReconnecting = false;

async function startBot({ method = 'saved', phone = null } = {}) {
  const sessionDir = path.resolve(process.cwd(), config.sessionPath);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch {
    version = [2, 3000, 1015901307];
  }

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.macOS('Safari'),
    markOnlineOnConnect: false,         // 🛡️ Anti-ban: no quedar "En línea" 24/7
    syncFullHistory: false,             // ⚡ No descargar historial viejo
    fireInitQueries: false,
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,         // 🔄 Mantiene viva la conexión en Termux
    retryRequestDelayMs: 400,
    msgRetryCounterCache,
    shouldIgnoreJid: jid => !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter'),
    getMessage: async (key) => {
      return messageStore.get(key?.id) || { conversation: '' };
    }
  });

  // Helper de caché de grupos adjunto al socket
  sock.getCachedGroupMetadata = async (jid, force = false) => {
    const cached = groupMetaCache.get(jid);
    if (!force && cached && Date.now() < cached.exp) return cached.data;
    const data = await sock.groupMetadata(jid);
    groupMetaCache.set(jid, { data, exp: Date.now() + GROUP_CACHE_TTL });
    return data;
  };
  sock.botStats = stats;

  // 🔢 Emparejamiento por código de 8 dígitos si se eligió opción 2
  if (method === 'code' && phone && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone);
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log(chalk.bgCyan.black('\n 🔑 CÓDIGO DE VINCULACIÓN ') + chalk.cyan.bold(`  ${formatted}\n`));
        console.log(chalk.gray('  Ve a WhatsApp → Dispositivos vinculados → Vincular con número de teléfono.\n'));
      } catch (err) {
        console.log(chalk.red('❌ Error pidiendo código de emparejamiento:'), err?.message || err);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  // 🔄 Manejo de conexión y reconexión estable con backoff progresivo
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && method !== 'code') {
      console.log(chalk.cyan('\n📱 Escanea este Código QR con el número del BOT:\n'));
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      isReconnecting = false;
      const myId = (sock.user?.id || '').split(':')[0];
      console.log(chalk.bgGreen.black('\n ✅ CONECTADO ') + chalk.green.bold(` ${config.botName} activo como +${myId}`));
      console.log(chalk.gray(' 🛡️ Escudo Anti-Ban activo | ⏱️ Ignorando mensajes anteriores al arranque\n'));
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const reasonText = lastDisconnect?.error?.message || `código ${statusCode}`;

      if (statusCode === DisconnectReason.loggedOut) {
        console.log(chalk.bgRed.white('\n 🚫 SESIÓN CERRADA ') + chalk.red(' Se desvinculó WhatsApp. Borra la carpeta "session" y vuelve a vincular.\n'));
        return;
      }

      if (!config.autoReconnect || isReconnecting) return;
      isReconnecting = true;
      reconnectAttempts++;

      const delay = Math.min(30000, 2500 * Math.pow(1.4, Math.min(reconnectAttempts, 6)));
      console.log(chalk.yellow(`\n⚠️ Conexión perdida (${reasonText}). Reconectando en ${(delay / 1000).toFixed(1)}s (intento #${reconnectAttempts})...`));

      setTimeout(() => {
        isReconnecting = false;
        startBot({ method: 'saved' });
      }, delay);
    }
  });

  // 📨 Recepción garantizada de TODOS los mensajes nuevos (ignora historial 'append')
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' || !Array.isArray(messages)) return;

    for (const msg of messages) {
      saveMsgToStore(msg);
      enqueueIncoming(sock, msg);
    }
  });

  // 👥 Actualizaciones de participantes (Bienvenidas y Despedidas + actualización de caché)
  sock.ev.on('group-participants.update', async (update) => {
    try {
      if (!update?.id) return;
      groupMetaCache.delete(update.id);
      if (update.action === 'add' || update.action === 'remove') {
        await dispatchGroupUpdate(sock, update.id, update.participants || [], update.action);
      }
    } catch (e) {
      console.log(chalk.red('❌ Error en evento de grupo:'), e?.message || e);
    }
  });

  // Invalidar caché si cambian nombre/descripción del grupo
  sock.ev.on('groups.update', (updates) => {
    for (const u of updates || []) {
      if (u?.id) groupMetaCache.delete(u.id);
    }
  });

  return sock;
}

module.exports = { startBot };
