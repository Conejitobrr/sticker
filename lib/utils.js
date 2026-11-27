'use strict';

function unwrapMessage(message = {}) {
  if (!message || typeof message !== 'object') return {};
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension?.message) return unwrapMessage(message.viewOnceMessageV2Extension.message);
  if (message.documentWithCaptionMessage?.message) return unwrapMessage(message.documentWithCaptionMessage.message);
  return message;
}

function getBody(msg) {
  const m = unwrapMessage(msg?.message);
  if (!m) return '';

  // Soporte nativo para clics de botones interactivos (NativeFlow 2026)
  try {
    const nativeJson = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
    if (nativeJson) {
      const parsed = JSON.parse(nativeJson);
      if (parsed?.id) return String(parsed.id);
    }
  } catch {}

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedId ||
    ''
  );
}

function normalizeJid(jid = '') {
  if (!jid) return '';
  return String(jid).split(':')[0];
}

function cleanNumber(jid = '') {
  return normalizeJid(jid).split('@')[0].replace(/\D/g, '');
}

function getContextInfo(msg) {
  const m = unwrapMessage(msg?.message);
  const key = Object.keys(m).find(k => m[k]?.contextInfo);
  return key ? m[key].contextInfo : null;
}

function getReadableType(msg) {
  const m = unwrapMessage(msg?.message);
  if (m.conversation || m.extendedTextMessage) return '📝 Texto';
  if (m.imageMessage) return '📸 Imagen';
  if (m.videoMessage) return '🎥 Video';
  if (m.audioMessage) return '🎵 Audio';
  if (m.stickerMessage) return '🧩 Sticker';
  if (m.documentMessage) return '📄 Documento';
  if (m.interactiveResponseMessage) return '🔘 Botón';
  return '📦 Multimedia/Otro';
}

module.exports = {
  unwrapMessage,
  getBody,
  normalizeJid,
  cleanNumber,
  getContextInfo,
  getReadableType
};
