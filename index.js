'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

// 🔇 Silencia logs internos ruidosos de Signal/Baileys sin borrar llaves
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
const origInfo = console.info;

const BLOCKED_REGEX = /Closing session|Closing open session|SessionEntry|_chains|chainKey|ephemeralKeyPair|registrationId|currentRatchet|pendingPreKey|messageKeys|remoteIdentityKey|Bad MAC|Failed to decrypt|MessageCounterError|Key used already or never filled|Session error:/i;

function shouldHide(args) {
  for (const arg of args) {
    if (typeof arg === 'string' && BLOCKED_REGEX.test(arg)) return true;
    if (arg && typeof arg === 'object') {
      const msg = String(arg.message || '');
      if (arg._chains || arg.currentRatchet || arg.pendingPreKey || arg.remoteIdentityKey || BLOCKED_REGEX.test(msg)) {
        return true;
      }
    }
  }
  return false;
}

console.log = (...a) => { if (!shouldHide(a)) origLog(...a); };
console.error = (...a) => { if (!shouldHide(a)) origErr(...a); };
console.warn = (...a) => { if (!shouldHide(a)) origWarn(...a); };
console.info = (...a) => { if (!shouldHide(a)) origInfo(...a); };

const readline = require('readline');
const chalk = require('chalk');
const figlet = require('figlet');
const config = require('./config');

const PID_FILE = path.resolve(process.cwd(), config.sessionPath, '.bot.pid');

function ensureDirs() {
  const dirs = ['lib', 'plugins', 'session', 'temp', 'assets'];
  for (const d of dirs) {
    const full = path.resolve(process.cwd(), d);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
  }

  const defaults = {
    'lib/database.json': { groups: {}, users: {} },
    'lib/owners.json': [],
    'lib/banned.json': {}
  };

  for (const [rel, val] of Object.entries(defaults)) {
    const fp = path.resolve(process.cwd(), rel);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, JSON.stringify(val, null, 2), 'utf8');
  }
}

async function enforceSingleInstance() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          origLog(chalk.yellow(`⚠️ Detectada otra instancia activa (PID ${oldPid}). Cerrándola...`));
          try { process.kill(oldPid, 'SIGTERM'); } catch {}
          await new Promise(r => setTimeout(r, 800));
          try { process.kill(oldPid, 'SIGKILL'); } catch {}
        } catch {}
      }
    }
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch {}
}

function cleanupPid() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const saved = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (saved === process.pid) fs.unlinkSync(PID_FILE);
    }
  } catch {}
}

process.on('exit', cleanupPid);
process.on('SIGINT', () => { cleanupPid(); process.exit(0); });
process.on('SIGTERM', () => { cleanupPid(); process.exit(0); });

function showBanner() {
  console.clear();
  try {
    const lines = figlet.textSync(config.botName, { font: 'Big' }).split('\n');
    lines.forEach(l => console.log(chalk.cyan.bold(l)));
  } catch {
    console.log(chalk.cyan.bold(`\n=== ${config.botName} ===\n`));
  }

  console.log(chalk.gray('  ─────────────────────────────────────────'));
  console.log(chalk.white('  🤖 Bot     : ') + chalk.green(config.botName));
  console.log(chalk.white('  🛡️ Modo    : ') + chalk.yellow('Anti-Ban + Conexión Estable'));
  console.log(chalk.white('  ⚙️ Prefijo : ') + chalk.yellow(config.prefix.join(' ')));
  console.log(chalk.gray('  ─────────────────────────────────────────\n'));
}

function hasSavedSession() {
  return fs.existsSync(path.resolve(process.cwd(), config.sessionPath, 'creds.json'));
}

function ask(rl, q) {
  return new Promise(res => rl.question(q, res));
}

async function askConnectionMethod() {
  if (hasSavedSession()) {
    console.log(chalk.green('✅ Sesión guardada encontrada. Conectando sin cargar historial viejo...\n'));
    return { method: 'saved', phone: null };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(chalk.cyan('¿Cómo deseas vincular el número del BOT?\n'));
    console.log(chalk.white('[1] Código QR'));
    console.log(chalk.white('[2] Código de 8 dígitos (Pairing Code)\n'));

    let choice = '';
    while (!['1', '2'].includes(choice)) {
      choice = (await ask(rl, chalk.yellow('→ Opción (1 o 2): '))).trim();
    }

    if (choice === '1') return { method: 'qr', phone: null };

    let phone = await ask(rl, chalk.yellow('→ Número del BOT con código de país (ej. 51999888777): '));
    phone = phone.replace(/\D/g, '');
    if (!phone) {
      console.log(chalk.red('\n❌ Número inválido. Saliendo...'));
      process.exit(1);
    }
    return { method: 'code', phone };
  } finally {
    rl.close();
  }
}

async function main() {
  ensureDirs();
  await enforceSingleInstance();
  showBanner();

  const { method, phone } = await askConnectionMethod();
  const { startBot } = require('./main');
  await startBot({ method, phone });
}

process.on('uncaughtException', err => {
  origErr(chalk.red('⚠️ Excepción capturada (bot sigue activo):'), err?.message || err);
});

process.on('unhandledRejection', err => {
  origErr(chalk.red('⚠️ Promesa rechazada (bot sigue activo):'), err?.message || err);
});

main();
