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

// ⏱️ Hora de arranque: ignora mensajes antiguos enviados antes de encender el bot
const BOOT_TIME_SEC = Math.floor(Date.now() / 1000);

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
        store.delete(store.keys().next().value);
      }
    },
    del(key) { store.delete(key); },
    flushAll() { store.clear(); }
  };
}

const msgRetryCounterCache = createSimpleCache(10 * 60 * 1000);

const messageStore = new Map();
function saveMsgToStore(msg) {
  const id = msg?.key?.id;
  if (!id || !msg?.message) return;
  messageStore.set(id, msg.message);
  if (messageStore.size > 1500) {
    messageStore.delete(messageStore.keys().next().value);
  }
}

const groupMetaCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000;

const processedIds = new Set();
const incomingQueue = [];
let activeWorkers = 0;
const MAX_CONCURRENT_WORKERS = 3;
const stats = { received: 0, processed: 0, skippedOld: 0, duplicates: 0, autoHeals: 0, reconnects: 0 };

function markProcessed(id) {
  if (!id || processedIds.has(id)) return false;
  processedIds.add(id);
  if (processedIds.size > 5000) {
    processedIds.delete(processedIds.values().next().value);
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

  if (!markProcessed(id)) {
    stats.duplicates++;
    return;
  }

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

// 🧹 Limpia SOLO llaves Signal corruptas (NUNCA borra creds.json ni pre-key-*.json)
function cleanCorruptedSignalSessions() {
  const sessionDir = path.resolve(process.cwd(), config.sessionPath);
  if (!fs.existsSync(sessionDir)) return 0;

  let removed = 0;
  for (const file of fs.readdirSync(sessionDir)) {
    if (
      file.startsWith('session-') ||
      file.startsWith('sender-key-') ||
      file.startsWith('sender-key-memory-')
    ) {
      try {
        fs.unlinkSync(path.join(sessionDir, file));
        removed++;
      } catch {}
    }
  }
  return removed;
}

// 🩺 Control global del socket activo, Watchdog y Auto-Reparación
let currentSock = null;
let watchdogTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let isReconnecting = false;

let signalErrorTimestamps = [];
let lastAutoHealAt = 0;

function destroySocket(sock) {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (!sock) return;
  try { sock.ev.removeAllListeners(); } catch {}
  try { sock.ws?.close(); } catch {}
  try { sock.end?.(); } catch {}
}

function scheduleReconnect(reason = 'desconexión', customDelayMs = null) {
  if (!config.autoReconnect || isReconnecting) return;
  isReconnecting = true;
  reconnectAttempts++;
  stats.reconnects++;

  const oldSock = currentSock;
  currentSock = null;
  destroySocket(oldSock);

  const delay = customDelayMs ?? Math.min(30000, 3000 * Math.pow(1.4, Math.min(reconnectAttempts, 6)));
  console.log(chalk.yellow(`\n⚠️ Reconexión programada (${reason}). Reintentando en ${(delay / 1000).toFixed(1)}s (intento #${reconnectAttempts})...`));

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    isReconnecting = false;
    startBot({ method: 'saved' });
  }, delay);
}

// 🩹 Auto-reparación si entra una ráfaga de MessageCounterError / Bad MAC
global.__onSignalSessionError = () => {
  const now = Date.now();
  signalErrorTimestamps = signalErrorTimestamps.filter(t => now - t < 15000);
  signalErrorTimestamps.push(now);

  // Si hay 15+ errores en 15 segundos y no se reparó en los últimos 3 minutos
  if (signalErrorTimestamps.length >= 15 && now - lastAutoHealAt > 3 * 60 * 1000) {
    lastAutoHealAt = now;
    signalErrorTimestamps = [];
    stats.autoHeals++;

    const removed = cleanCorruptedSignalSessions();
    console.log(chalk.bgYellow.black('\n 🩹 AUTO-REPARACIÓN DE SESIÓN ') + chalk.yellow(` Se limpiaron ${removed} llaves corruptas (creds intacto). Reconectando...`));
    scheduleReconnect('auto-reparación Signal', 2500);
  }
};

// 💓 Watchdog: detecta conexiones "fantasma" (socket abierto pero congelado)
function startWatchdog(sock) {
  if (watchdogTimer) clearInterval(watchdogTimer);
  let missedPings = 0;

  watchdogTimer = setInterval(async () => {
    if (sock !== currentSock) {
      clearInterval(watchdogTimer);
      return;
    }

    const readyState = sock.ws?.readyState;
    if (readyState !== 1) {
      missedPings++;
      if (missedPings >= 2) {
        console.log(chalk.red('\n🔌 [WATCHDOG] WebSocket cerrado silenciosamente. Forzando reconexión...'));
        scheduleReconnect('socket cerrado', 2000);
      }
      return;
    }

    try {
      // Ping XMPP oficial de WhatsApp con timeout de 15s (no envía mensajes ni dispara anti-ban)
      await Promise.race([
        sock.query({
          tag: 'iq',
          attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:p' },
          content: [{ tag: 'ping', attrs: {} }]
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('PING_TIMEOUT')), 15000))
      ]);
      missedPings = 0;
    } catch {
      missedPings++;
      console.log(chalk.yellow(`⚠️ [WATCHDOG] Latido sin respuesta (${missedPings}/2)...`));
      if (missedPings >= 2) {
        console.log(chalk.red('\n💀 [WATCHDOG] Conexión congelada detectada. Reiniciando socket limpiamente...'));
        scheduleReconnect('conexión congelada', 2000);
      }
    }
  }, 60000);
}

async function startBot({ method = 'saved', phone = null } = {}) {
  // Aseguramos destruir cualquier socket previo antes de abrir uno nuevo
  if (currentSock) {
    destroySocket(currentSock);
    currentSock = null;
  }

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
    browser: Browsers.macOS('Safari'),  // 🍎 Aparece como Safari (Mac OS)
    markOnlineOnConnect: false,         // 🛡️ No quedar "En línea" 24/7
    syncFullHistory: false,             // ⚡ No descargar historial viejo
    fireInitQueries: false,
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 45000,
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 45000,
    retryRequestDelayMs: 400,
    msgRetryCounterCache,
    shouldIgnoreJid: jid => !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter'),
    getMessage: async (key) => {
      return messageStore.get(key?.id) || { conversation: '' };
    }
  });

  currentSock = sock;

  sock.getCachedGroupMetadata = async (jid, force = false) => {
    const cached = groupMetaCache.get(jid);
    if (!force && cached && Date.now() < cached.exp) return cached.data;
    const data = await sock.groupMetadata(jid);
    groupMetaCache.set(jid, { data, exp: Date.now() + GROUP_CACHE_TTL });
    return data;
  };
  sock.botStats = stats;
  sock.cleanSignalAndReconnect = () => {
    const removed = cleanCorruptedSignalSessions();
    scheduleReconnect('limpieza manual Owner', 2000);
    return removed;
  };

  if (method === 'code' && phone && !sock.authState.creds.registered) {
    setTimeout(async () => {
      if (sock !== currentSock) return;
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

  sock.ev.on('connection.update', async (update) => {
    if (sock !== currentSock) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr && method !== 'code') {
      console.log(chalk.cyan('\n📱 Escanea este Código QR con el número del BOT:\n'));
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      isReconnecting = false;
      startWatchdog(sock);
      const myId = (sock.user?.id || '').split(':')[0];
      console.log(chalk.bgGreen.black('\n ✅ CONECTADO ') + chalk.green.bold(` ${config.botName} activo como +${myId}`));
      console.log(chalk.gray(' 🛡️ Anti-Ban + Watchdog 60s + Auto-Reparación activos\n'));
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const reasonText = lastDisconnect?.error?.message || `código ${statusCode}`;

      if (statusCode === DisconnectReason.loggedOut) {
        destroySocket(sock);
        currentSock = null;
        console.log(chalk.bgRed.white('\n 🚫 SESIÓN CERRADA ') + chalk.red(' WhatsApp desvinculó el dispositivo. Borra "session" y vuelve a vincular.\n'));
        return;
      }

      // Si hubo conflicto (440) damos un respiro más largo antes de reconectar
      const customDelay = statusCode === DisconnectReason.connectionReplaced ? 8000 : null;
      scheduleReconnect(reasonText, customDelay);
    }
  });

  // 📨 Recibe mensajes nuevos (notify) y los enviados desde tu propio WhatsApp (append)
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (sock !== currentSock) return;
    if ((type !== 'notify' && type !== 'append') || !Array.isArray(messages)) return;

    for (const msg of messages) {
      if (type === 'append') {
        const ts = getMsgTimestampSec(msg);
        if (ts < BOOT_TIME_SEC - 3) {
          stats.skippedOld++;
          continue;
        }
      }
      saveMsgToStore(msg);
      enqueueIncoming(sock, msg);
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    if (sock !== currentSock) return;
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

  sock.ev.on('groups.update', (updates) => {
    for (const u of updates || []) {
      if (u?.id) groupMetaCache.delete(u.id);
    }
  });

  return sock;
}

module.exports = { startBot, cleanCorruptedSignalSessions };
