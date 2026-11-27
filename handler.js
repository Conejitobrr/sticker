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

const BANNED_PATH = path.join(process.cwd(), 'lib', 'banned.json');
const recentGroupEvents = new Map();

function cleanJid(jid = '') {
  return String(jid).split(':')[0];
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
// 🛡️ PROTECCIÓN ANTI-BAN & ANTI-OVERLIMIT
// ==========================================
const sendQueue = [];
let isSending = false;
const outgoingTimestamps = [];
const userCooldowns = new Map();
const groupBurstMap = new Map();

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
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

  while (sendQueue.length > 0) {
    const task = sendQueue.shift();
    await waitForRateLimitSlot();
    try {
      await task();
    } catch {}
    if (sendQueue.length > 0) {
      await sleep(randomDelay(minDelay, maxDelay));
    }
  }
  isSending = false;
}

function checkAntiSpam(remoteJid, senderNum, fromGroup, isOwner) {
  if (isOwner) return null;
  const now = Date.now();

  // 1. Cooldown individual por usuario
  const userCd = config.antiBan?.userCooldownMs || 4000;
  const lastUser = userCooldowns.get(senderNum) || 0;
  if (now - lastUser < userCd) {
    return 'user_cooldown';
  }
  userCooldowns.set(senderNum, now);

  // 2. Protección anti-ráfaga en grupo (máx X comandos cada 20s)
  if (fromGroup) {
    const maxGroup = config.antiBan?.groupMaxCmdsPer20s || 6;
    const list = (groupBurstMap.get(remoteJid) || []).filter(t => now - t < 20000);
    if (list.length >= maxGroup) {
      return 'group_burst';
    }
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
  attachSendLogger(sock);

  const validParticipants = participants.filter(p => {
    const jid = typeof p === 'string' ? p : (p?.id || p?.jid || '');
    return jid && !isDuplicateGroupEvent(id, jid, action);
  });
  if (!validParticipants.length) return;

  for (const listener of groupListeners) {
    try {
      await listener.onGroupUpdate({ sock, conn: sock, id, participants: validParticipants, action, db, config });
    } catch (e) {
      console.log(chalk.red(`❌ Error en onGroupUpdate: ${e?.message || e}`));
    }
  }
}

function attachSendLogger(sock) {
  if (sock._loggerAttached) return;
  sock._loggerAttached = true;

  const originalSend = sock.sendMessage.bind(sock);

  sock.sendMessage = async (jid, content = {}, options = {}) => {
    return new Promise((resolve, reject) => {
      sendQueue.push(async () => {
        try {
          // Simulación humana breve (solo en respuestas de texto/media, no en reacciones/borrados)
          if (config.antiBan?.simulateTyping && !content.react && !content.delete) {
            try {
              const presence = content.audio ? 'recording' : 'composing';
              await sock.sendPresenceUpdate(presence, jid);
              await sleep(randomDelay(350, 750));
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

          const result = await originalSend(jid, content, options);

          if (config.antiBan?.simulateTyping && !content.react && !content.delete) {
            try { await sock.sendPresenceUpdate('paused', jid); } catch {}
          }

          resolve(result);
        } catch (err) {
          const msgErr = String(err?.message || err);
          // 🛡️ Detección automática de rate-overlimit / 429
          if (/overlimit|rate|429|too many/i.test(msgErr)) {
            const pause = config.antiBan?.overlimitPauseMs || 15000;
            console.log(chalk.bgYellow.black(' 🛡️ OVERLIMIT DETECTADO ') + chalk.yellow(` Enfriando envíos ${pause / 1000}s y reintentando...`));
            await sleep(pause);
            try {
              const retryRes = await originalSend(jid, content, options);
              return resolve(retryRes);
            } catch (e2) {
              return reject(e2);
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
  };

  if (!sock.reply) {
    sock.reply = (jid, text, quoted, options = {}) => sock.sendMessage(jid, { text: String(text), ...options }, { quoted });
  }
}

function loadPlugins() {
  commands.clear();
  aliases.clear();
  messageListeners.length = 0;
  groupListeners.length = 0;

  // Comando integrado .ping / .estado (incluye verificador de mensajes leídos)
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
    attachSendLogger(sock);

    // Respaldo para entradas/salidas vía messageStubType
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

    const key = msg.key || {};
    const remoteJid = key.remoteJid;
    if (!remoteJid || remoteJid === 'status@broadcast') return;

    const fromGroup = remoteJid.endsWith('@g.us');
    let sender = fromGroup ? (key.participant || msg.participant) : remoteJid;
    sender = normalizeJid(sender || remoteJid);

    const botJid = normalizeJid(sock.user?.id || '');
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

          // Resolver número real si el grupo usa @lid
          const meInGroup = participants.find(p => cleanNumber(p.id) === senderNumber || cleanNumber(p.lid) === senderNumber);
          if (meInGroup?.phoneNumber) resolvedPhoneNum = cleanNumber(meInGroup.phoneNumber);
        }
      } catch {
        groupName = 'Grupo';
      }
    }

    // 👑 Verificación dinámica de Owner (Bot + defaultOwners + lib/owners.json, compatible con @lid)
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

    const replyFn = (text, options = {}) => sock.sendMessage(remoteJid, { text: String(text), ...options }, { quoted: msg });
    msg.reply = replyFn;

    const groupData = fromGroup ? await db.getGroup(remoteJid) : null;
    const userData = await db.getUser(sender);

    const baseCtx = {
      sock, conn: sock,
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

    // 🛡️ Verificación Anti-Spam / Cooldown (evita saturar WhatsApp)
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
      console.log(chalk.red(`❌ Error en comando ${rawCommand}: ${e?.message || e}`));
      await replyFn('❌ Ocurrió un error interno al ejecutar este comando.');
    }
  } catch (err) {
    console.log(chalk.red(`❌ Error crítico en handler: ${err?.message || err}`));
  }
}

module.exports = { messageHandler, dispatchGroupUpdate, loadPlugins, commands, aliases };
