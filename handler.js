'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const config = require('./config');
const db = require('./lib/database');
const {
  getBody,
  normalizeJid,
  cleanNumber,
  getReadableType,
  getContextInfo,
  unwrapMessage
} = require('./lib/utils');

const recentGroupEvents = new Map();
const botSentIds = new Set();

let activeSock = null;
let lastKnownUser = null;

function setActiveSocket(sock) {
  activeSock = sock;
  if (sock?.user) lastKnownUser = sock.user;
}

function isSocketReady(sock) {
  if (!sock?.ws) return false;
  if (typeof sock.ws.isOpen === 'boolean') return sock.ws.isOpen;
  if (sock.ws.socket && typeof sock.ws.socket.readyState === 'number') return sock.ws.socket.readyState === 1;
  if (typeof sock.ws.readyState === 'number') return sock.ws.readyState === 1;
  return true;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function waitForActiveSocket(timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (activeSock && isSocketReady(activeSock)) return activeSock;
    await sleep(300);
  }
  return activeSock && isSocketReady(activeSock) ? activeSock : null;
}

function getTime() {
  return new Date().toLocaleTimeString('es-PE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

function isDuplicateGroupEvent(groupId, userJid, action) {
  const key = `${groupId}_${cleanNumber(userJid)}_${action}`;
  const now = Date.now();
  const last = recentGroupEvents.get(key) || 0;
  if (now - last < 8000) return true;
  recentGroupEvents.set(key, now);
  return false;
}

function parseCommandPrefix(text = '') {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const validPrefixes = Array.isArray(config.prefix) ? config.prefix : [String(config.prefix || '.')];
  const matched = validPrefixes.find(p => trimmed.startsWith(p));
  if (!matched) return null;
  return {
    prefix: matched,
    body: trimmed.slice(matched.length).trim()
  };
}

// ==========================================
// 🛡️ PROTECCIÓN ANTI-BAN Y COLA SEGURA
// ==========================================
const sendQueue = [];
let isSending = false;
const outgoingTimestamps = [];
const userCooldowns = new Map();
const groupBurstMap = new Map();

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitForRateLimitSlot() {
  const maxPerMin = config.antiBan?.maxOutgoingPerMinute || 18;
  while (true) {
    const now = Date.now();
    while (outgoingTimestamps.length && now - outgoingTimestamps[0] > 60000) {
      outgoingTimestamps.shift();
    }
    if (outgoingTimestamps.length < maxPerMin) {
      outgoingTimestamps.push(now);
      return;
    }
    const waitMs = Math.max(1000, 60000 - (now - outgoingTimestamps[0]) + 500);
    console.log(chalk.yellow(`🛡️ [ANTI-BAN] Límite de ${maxPerMin} envíos/min alcanzado. Pausando ${(waitMs / 1000).toFixed(1)}s...`));
    await sleep(waitMs);
  }
}

async function processSendQueue() {
  if (isSending || sendQueue.length === 0) return;
  isSending = true;

  const minDelay = config.antiBan?.minSendDelayMs || 1200;
  const maxDelay = config.antiBan?.maxSendDelayMs || 2200;

  try {
    while (sendQueue.length > 0) {
      const task = sendQueue.shift();
      await waitForRateLimitSlot();
      try {
        await Promise.race([
          task(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('QUEUE_HARD_TIMEOUT')), 35000))
        ]);
      } catch {}
      if (sendQueue.length > 0) {
        await sleep(randomDelay(minDelay, maxDelay));
      }
    }
  } finally {
    isSending = false;
    if (sendQueue.length > 0) processSendQueue();
  }
}

function queuedSendMessage(jid, content = {}, options = {}) {
  return new Promise((resolve, reject) => {
    sendQueue.push(async () => {
      try {
        const sock = await waitForActiveSocket(12000);
        if (!sock || !sock._rawSendMessage) {
          throw new Error('Connection Closed');
        }

        // Simulación humana con timeout estricto de 2s para jamás trabar la cola
        if (config.antiBan?.simulateTyping && !content.react && !content.delete) {
          try {
            const presence = content.audio ? 'recording' : 'composing';
            await Promise.race([
              sock.sendPresenceUpdate(presence, jid).catch(() => {}),
              sleep(2000)
            ]);
            await sleep(randomDelay(350, 700));
          } catch {}
        }

        if (config.debug && !content.react) {
          const isGroup = String(jid).endsWith('@g.us');
          let type = '📝 Texto';
          let preview = content.text || '';

          if (content.image) { type = '📸 Imagen'; preview = content.caption || '[Imagen]'; }
          else if (content.video) { type = '🎥 Video'; preview = content.caption || '[Video]'; }
          else if (content.audio) { type = '🎵 Audio'; preview = '[Audio]'; }
          else if (content.sticker) { type = '🧩 Sticker'; preview = '[Sticker]'; }
          else if (content.document) { type = '📄 Documento'; preview = content.fileName || '[Documento]'; }

          const labelType = isGroup ? chalk.magenta('👥 GRUPO') : chalk.blue('👤 PRIVADO');
          const time = getTime();

          console.log(chalk.gray(`╭─── 📤 `) + chalk.cyan.bold(`BOT ENVÍA`) + chalk.cyan(` [${time}]`) + chalk.gray(` ───────────────`));
          console.log(chalk.gray(`│ 🏷️  Destino : `) + labelType + chalk.yellow(` (+${cleanNumber(jid)})`));
          console.log(chalk.gray(`│ 📦  Tipo    : `) + chalk.white(type));
          if (preview) console.log(chalk.gray(`│ 💬  Msg     : `) + chalk.green(String(preview).slice(0, 70).replace(/\n/g, ' ')));
          console.log(chalk.gray(`╰──────────────────────────────────────────\n`));
        }

        const rawPromise = sock._rawSendMessage(jid, content, options);
        rawPromise.catch(() => {});

        const result = await Promise.race([
          rawPromise,
          new Promise((_, rej) => setTimeout(() => rej(new Error('SEND_TIMEOUT')), 25000))
        ]);

        if (result?.key?.id) {
          botSentIds.add(result.key.id);
          if (botSentIds.size > 500) botSentIds.delete(botSentIds.values().next().value);
        }

        if (config.antiBan?.simulateTyping && !content.react && !content.delete) {
          sock.sendPresenceUpdate('paused', jid).catch(() => {});
        }

        resolve(result);
      } catch (err) {
        const msgErr = String(err?.message || err);
        if (/overlimit|rate|429|too many/i.test(msgErr)) {
          const pause = config.antiBan?.overlimitPauseMs || 15000;
          console.log(chalk.bgYellow.black(' 🛡️ OVERLIMIT DETECTADO ') + chalk.yellow(` Enfriando ${pause / 1000}s y reintentando...`));
          await sleep(pause);
          const freshSock = await waitForActiveSocket(10000);
          if (freshSock?._rawSendMessage) {
            try {
              const retryRes = await freshSock._rawSendMessage(jid, content, options);
              if (retryRes?.key?.id) botSentIds.add(retryRes.key.id);
              return resolve(retryRes);
            } catch (e2) {
              return reject(e2);
            }
          }
        }

        const time = getTime();
        console.log(chalk.gray(`╭─── ❌ `) + chalk.red.bold(`ERROR ENVÍO`) + chalk.cyan(` [${time}]`) + chalk.gray(` ─────────────`));
        console.log(chalk.gray(`│ ⚠️  Detalle : `) + chalk.red(msgErr));
        console.log(chalk.gray(`╰──────────────────────────────────────────\n`));
        reject(err);
      }
    });
    processSendQueue();
  });
}

// 🔌 Proxy vivo: los plugins largos (.saudio, .s2, .crop) siempre usan el socket conectado más reciente
const liveSock = new Proxy({}, {
  get(_, prop) {
    if (prop === 'sendMessage') return queuedSendMessage;
    if (prop === 'reply') {
      return (jid, text, quoted, options = {}) => queuedSendMessage(jid, { text: String(text), ...options }, { quoted });
    }
    if (prop === 'relayMessage') {
      return async (jid, message, opts = {}) => {
        const s = await waitForActiveSocket(12000);
        if (!s) throw new Error('Connection Closed');
        const res = await s.relayMessage(jid, message, opts);
        if (opts?.messageId) {
          botSentIds.add(opts.messageId);
          if (botSentIds.size > 500) botSentIds.delete(botSentIds.values().next().value);
        }
        return res;
      };
    }
    if (prop === 'waUploadToServer') {
      return async (...args) => {
        const s = await waitForActiveSocket(12000);
        if (!s) throw new Error('Connection Closed');
        return s.waUploadToServer(...args);
      };
    }
    if (prop === 'user') return activeSock?.user || lastKnownUser || {};

    const s = activeSock;
    if (!s) return undefined;
    const val = s[prop];
    return typeof val === 'function' ? val.bind(s) : val;
  }
});

function attachSendLogger(sock) {
  if (!sock || sock._loggerAttached) return;
  sock._loggerAttached = true;
  sock._rawSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = queuedSendMessage;
  if (!sock.reply) {
    sock.reply = (jid, text, quoted, options = {}) => queuedSendMessage(jid, { text: String(text), ...options }, { quoted });
  }
}

function checkAntiSpam(remoteJid, senderNum, fromGroup, isOwner) {
  if (isOwner) return null;
  const now = Date.now();

  const userCd = config.antiBan?.userCooldownMs || 4000;
  const lastUser = userCooldowns.get(senderNum) || 0;
  if (now - lastUser < userCd) return 'user_cooldown';
  userCooldowns.set(senderNum, now);

  if (fromGroup) {
    const maxGroup = config.antiBan?.groupMaxCmdsPer20s || 6;
    const list = (groupBurstMap.get(remoteJid) || []).filter(t => now - t < 20000);
    if (list.length >= maxGroup) return 'group_burst';
    list.push(now);
    groupBurstMap.set(remoteJid, list);
  }
  return null;
}

// ==========================================
// 🧩 CARGADOR UNIVERSAL DE PLUGINS
// ==========================================
const PLUGINS_DIR = path.join(process.cwd(), 'plugins');
if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });

const commands = new Map();
const aliases = new Map();
const messageListeners = [];
const groupListeners = [];

function getAllPluginFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getAllPluginFiles(fullPath, arrayOfFiles);
    } else if (file.endsWith('.js')) {
      arrayOfFiles.push(fullPath);
    }
  }
  return arrayOfFiles;
}

async function dispatchGroupUpdate(sock, id, participants, action) {
  if (!id || !Array.isArray(participants) || !participants.length) return;
  const validParticipants = participants.filter(p => {
    const jid = typeof p === 'string' ? p : (p?.id || p?.jid || '');
    return jid && !isDuplicateGroupEvent(id, jid, action);
  });
  if (!validParticipants.length) return;

  for (const listener of groupListeners) {
    try {
      await listener.onGroupUpdate({ sock: liveSock, conn: liveSock, id, participants: validParticipants, action, db, config });
    } catch (e) {
      console.log(chalk.red(`❌ Error en onGroupUpdate: ${e?.message || e}`));
    }
  }
}

function loadPlugins() {
  commands.clear();
  aliases.clear();
  messageListeners.length = 0;
  groupListeners.length = 0;

  const builtinPing = {
    name: 'ping',
    aliases: ['p', 'estado', 'status'],
    category: 'utilidad',
    desc: 'Muestra rendimiento, estado anti-ban y contador de mensajes verificados',
    execute: async ({ sock, reply }) => {
      const usedRam = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      const totalRam = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
      const st = sock.botStats || { received: 0, processed: 0, skippedOld: 0 };
      const upSec = Math.floor(process.uptime());
      const h = Math.floor(upSec / 3600);
      const m = Math.floor((upSec % 3600) / 60);
      const s = upSec % 60;

      await reply(
        `🚀 *${config.botName} v${config.botVersion}*\n\n` +
        `⏱️ *Activo:* ${h}h ${m}m ${s}s\n` +
        `🧩 *Plugins activos:* ${commands.size}\n` +
        `🧠 *RAM:* ${usedRam} MB / ${totalRam} GB\n` +
        `🛡️ *Envíos último min:* ${outgoingTimestamps.length}/${config.antiBan.maxOutgoingPerMinute}\n` +
        `📨 *Mensajes verificados:* ${st.processed}/${st.received} *(viejos ignorados: ${st.skippedOld})*`
      );
    }
  };
  commands.set('ping', builtinPing);
  for (const a of builtinPing.aliases) aliases.set(a, 'ping');

  const files = getAllPluginFiles(PLUGINS_DIR);
  let cmdCount = 0;
  let listenerCount = 0;

  for (const filepath of files) {
    try {
      delete require.cache[require.resolve(filepath)];
      const rawPlugin = require(filepath);

      const executeFn =
        typeof rawPlugin === 'function'
          ? (ctx) => rawPlugin(ctx.m, ctx)
          : (rawPlugin.execute || rawPlugin.run || rawPlugin.handler);

      const cmdNameRaw = rawPlugin.name || (Array.isArray(rawPlugin.command) ? rawPlugin.command[0] : rawPlugin.command);

      if (cmdNameRaw && typeof executeFn === 'function') {
        const cmdName = String(cmdNameRaw).toLowerCase().trim();
        const normalizedPlugin = typeof rawPlugin === 'function'
          ? { name: cmdName, execute: executeFn }
          : { ...rawPlugin, name: cmdName, execute: executeFn };

        commands.set(cmdName, normalizedPlugin);

        const pluginAliases = [
          ...(Array.isArray(rawPlugin.aliases) ? rawPlugin.aliases : []),
          ...(Array.isArray(rawPlugin.alias) ? rawPlugin.alias : []),
          ...(Array.isArray(rawPlugin.command) ? rawPlugin.command.slice(1) : [])
        ];

        for (const alias of pluginAliases) {
          if (typeof alias === 'string') aliases.set(alias.toLowerCase().trim(), cmdName);
        }
        cmdCount++;
      }

      if (typeof rawPlugin.onMessage === 'function') {
        messageListeners.push(rawPlugin);
        listenerCount++;
      } else if (typeof rawPlugin.before === 'function') {
        messageListeners.push({ onMessage: (ctx) => rawPlugin.before(ctx.m, ctx) });
        listenerCount++;
      }

      if (typeof rawPlugin.onGroupUpdate === 'function') {
        groupListeners.push(rawPlugin);
      }
    } catch (err) {
      console.log(chalk.bgRed.white(' ❌ ERROR PLUGIN '), chalk.red(`Fallo en ${path.basename(filepath)}: ${err?.message}`));
    }
  }

  console.log(chalk.bgGreen.black('\n ♻️ PLUGINS LISTOS '), chalk.green(`${cmdCount} plugins (+ ping) y ${listenerCount} detectores activos.\n`));
}

loadPlugins();

async function messageHandler(sock, msg, store = {}) {
  try {
    if (msg?.messageStubType && msg?.key?.remoteJid?.endsWith('@g.us')) {
      const stub = msg.messageStubType;
      const params = Array.isArray(msg.messageStubParameters) ? msg.messageStubParameters : [];
      if (stub === 27 || stub === 31) {
        await dispatchGroupUpdate(sock, msg.key.remoteJid, params, 'add');
      } else if (stub === 28 || stub === 32) {
        await dispatchGroupUpdate(sock, msg.key.remoteJid, params, 'remove');
      }
    }

    if (!msg?.message) return;
    if (msg.key?.id && botSentIds.has(msg.key.id)) return;

    const key = msg.key || {};
    const remoteJid = key.remoteJid;
    if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) return;

    const fromGroup = remoteJid.endsWith('@g.us');
    let sender = fromGroup ? (key.participant || msg.participant) : remoteJid;
    sender = normalizeJid(sender || remoteJid);

    const botJid = normalizeJid((activeSock?.user || sock?.user)?.id || '');
    const body = getBody(msg);
    const pushName = msg.pushName || 'Usuario';
    const senderNumber = cleanNumber(sender);

    let groupName = 'Privado';
    let chatLabel = chalk.blue('👤 PRIVADO');
    let isAdmin = false;
    let isBotAdmin = false;
    let participants = [];
    let resolvedPhoneNum = senderNumber;

    if (fromGroup) {
      chatLabel = chalk.magenta('👥 GRUPO');
      try {
        const metadata = sock.getCachedGroupMetadata
          ? await sock.getCachedGroupMetadata(remoteJid)
          : await sock.groupMetadata(remoteJid);

        if (metadata) {
          groupName = metadata.subject || 'Grupo';
          participants = metadata.participants || [];
          const admins = participants
            .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
            .map(p => cleanNumber(p.id));
          isAdmin = admins.includes(senderNumber);
          isBotAdmin = admins.includes(cleanNumber(botJid));

          const meInGroup = participants.find(p => cleanNumber(p.id) === senderNumber || cleanNumber(p.lid) === senderNumber);
          if (meInGroup?.phoneNumber) resolvedPhoneNum = cleanNumber(meInGroup.phoneNumber);
        }
      } catch {
        groupName = 'Grupo';
      }
    }

    const ownerNumbers = config.owner;
    const isOwner = !!key.fromMe || ownerNumbers.includes(senderNumber) || ownerNumbers.includes(resolvedPhoneNum);

    if (config.debug) {
      const msgType = getReadableType(msg);
      const adminStatus = isAdmin ? chalk.green('Sí') : chalk.red('No');
      const ownerStatus = isOwner ? chalk.green('Sí') : chalk.red('No');
      const time = getTime();

      console.log(chalk.gray(`╭─── 📥 `) + chalk.green.bold(`MENSAJE ENTRANTE`) + chalk.cyan(` [${time}]`) + chalk.gray(` ──────────`));
      console.log(chalk.gray(`│ 🏷️  Chat    : `) + chatLabel + (fromGroup ? chalk.white(` ${groupName}`) : ''));
      console.log(chalk.gray(`│ 👤  De      : `) + chalk.white(pushName) + chalk.yellow(` (+${senderNumber})`));
      console.log(chalk.gray(`│ 🛡️  Admin   : `) + adminStatus + chalk.gray(` | 👑 Owner: `) + ownerStatus);
      console.log(chalk.gray(`│ 📦  Tipo    : `) + chalk.white(msgType));
      console.log(chalk.gray(`│ 💬  Texto   : `) + chalk.white(String(body || '[Multimedia/Sticker]').slice(0, 100).replace(/\n/g, ' ')));
      console.log(chalk.gray(`╰──────────────────────────────────────────`));
    }

    const contextInfo = getContextInfo(msg) || {};
    const mentionedJid = (contextInfo.mentionedJid || []).map(j => normalizeJid(j));
    const quotedSender = contextInfo.participant ? normalizeJid(contextInfo.participant) : null;

    if (contextInfo && (mentionedJid.length || quotedSender)) {
      msg.message.extendedTextMessage = msg.message.extendedTextMessage || {};
      msg.message.extendedTextMessage.contextInfo = {
        ...(msg.message.extendedTextMessage.contextInfo || {}),
        participant: contextInfo.participant || quotedSender,
        mentionedJid: contextInfo.mentionedJid || mentionedJid
      };
    }

    msg.chat = remoteJid;
    msg.sender = sender;
    msg.text = body;
    msg.isGroup = fromGroup;
    msg.mentionedJid = mentionedJid;
    msg.quoted = contextInfo.quotedMessage ? {
      key: {
        remoteJid,
        fromMe: cleanNumber(quotedSender) === cleanNumber(botJid),
        id: contextInfo.stanzaId,
        participant: quotedSender
      },
      message: unwrapMessage(contextInfo.quotedMessage),
      sender: quotedSender,
      text: getBody({ message: contextInfo.quotedMessage })
    } : null;

    const replyFn = (text, options = {}) => queuedSendMessage(remoteJid, { text: String(text), ...options }, { quoted: msg });
    msg.reply = replyFn;

    const groupData = fromGroup ? await db.getGroup(remoteJid) : null;
    const userData = await db.getUser(sender);

    const baseCtx = {
      sock: liveSock, conn: liveSock,
      msg, m: msg,
      remoteJid, chat: remoteJid,
      sender, botJid, pushName, body, text: body,
      config, db, store,
      fromGroup, isGroup: fromGroup,
      isOwner, isAdmin, isBotAdmin,
      participants, groupData, userData,
      mentionedJid, quoted: msg.quoted,
      reply: replyFn,
      reloadPlugins: loadPlugins
    };

    if (!fromGroup || (groupData && groupData.bot !== false) || isOwner) {
      await Promise.allSettled(
        messageListeners.map(listener => typeof listener.onMessage === 'function' ? listener.onMessage(baseCtx) : null)
      );
    }

    if (!body) return;

    const parsed = parseCommandPrefix(body);
    if (!parsed) return;

    const args = parsed.body.trim().split(/\s+/).filter(Boolean);
    const rawCommand = args.shift()?.toLowerCase();
    if (!rawCommand) return;

    const cmdKey = aliases.has(rawCommand) ? aliases.get(rawCommand) : rawCommand;
    const plugin = commands.get(cmdKey);
    if (!plugin) return;

    if (fromGroup && groupData && groupData.bot === false && !isOwner && cmdKey !== 'config') return;

    const spamReason = checkAntiSpam(remoteJid, senderNumber, fromGroup, isOwner);
    if (spamReason) {
      if (config.debug) {
        console.log(chalk.yellow(`🛡️ [ANTI-SPAM] Comando .${rawCommand} ignorado (${spamReason}) para proteger la cuenta.\n`));
      }
      return;
    }

    if (config.debug) {
      const time = getTime();
      console.log(chalk.gray(`╭─── ⚡ `) + chalk.yellow.bold(`EJECUTANDO COMANDO`) + chalk.cyan(` [${time}]`) + chalk.gray(` ────────`));
      console.log(chalk.gray(`│ 🚀  Cmd     : `) + chalk.yellow(`${parsed.prefix}${rawCommand}`));
      console.log(chalk.gray(`│ 👤  Por     : `) + chalk.white(pushName));
      console.log(chalk.gray(`╰──────────────────────────────────────────`));
    }

    try {
      await plugin.execute({
        ...baseCtx,
        args,
        text: args.join(' '),
        usedPrefix: parsed.prefix,
        commandName: rawCommand,
        command: rawCommand
      });

      if (config.debug) {
        const time = getTime();
        console.log(chalk.gray(`╭─── ✅ `) + chalk.green.bold(`ÉXITO`) + chalk.cyan(` [${time}]`) + chalk.gray(` ─────────────────────`));
        console.log(chalk.gray(`│ ⚙️  Comando completado sin errores.`));
        console.log(chalk.gray(`╰──────────────────────────────────────────\n`));
      }
    } catch (e) {
      const errMsg = String(e?.message || e);
      console.log(chalk.red(`❌ Error en comando ${rawCommand}: ${errMsg}`));
      // Si el error fue por caída de red momentánea, no encadena otro envío fallido
      if (!/Connection Closed|SEND_TIMEOUT|QUEUE_HARD_TIMEOUT/i.test(errMsg)) {
        await replyFn('❌ Ocurrió un error interno al ejecutar este comando.').catch(() => {});
      }
    }
  } catch (err) {
    const errMsg = String(err?.message || err);
    if (!/Connection Closed/i.test(errMsg)) {
      console.log(chalk.red(`❌ Error crítico en handler: ${errMsg}`));
    }
  }
}

module.exports = {
  messageHandler,
  dispatchGroupUpdate,
  setActiveSocket,
  attachSendLogger,
  loadPlugins,
  commands,
  aliases
};
