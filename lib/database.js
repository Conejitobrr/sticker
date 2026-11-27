'use strict';

const fs = require('fs');
const path = require('path');

const DB_PATH = path.resolve(process.cwd(), 'lib', 'database.json');

function ensureDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ groups: {}, users: {} }, null, 2));
  }
}

function readDB() {
  ensureDB();
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return { groups: data.groups || {}, users: data.users || {} };
  } catch {
    return { groups: {}, users: {} };
  }
}

function writeDB(data) {
  ensureDB();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

async function getGroup(id) {
  const db = readDB();
  if (!db.groups[id]) {
    db.groups[id] = { id, bot: true, welcome: false };
    writeDB(db);
  }
  const groupObj = { ...db.groups[id] };
  groupObj.save = async function () {
    const fresh = readDB();
    const { save, ...plain } = this;
    fresh.groups[id] = plain;
    writeDB(fresh);
    return this;
  };
  return groupObj;
}

async function setGroup(id, data = {}) {
  const db = readDB();
  const { save, ...plain } = data;
  db.groups[id] = { ...(db.groups[id] || { id, bot: true, welcome: false }), ...plain, id };
  writeDB(db);
  return db.groups[id];
}

async function getUser(id) {
  const db = readDB();
  if (!db.users[id]) {
    db.users[id] = { id, xp: 0, banned: false };
    writeDB(db);
  }
  const userObj = { ...db.users[id] };
  userObj.save = async function () {
    const fresh = readDB();
    const { save, ...plain } = this;
    fresh.users[id] = plain;
    writeDB(fresh);
    return this;
  };
  return userObj;
}

module.exports = { getGroup, setGroup, getUser };
