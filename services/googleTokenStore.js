'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(STORE_DIR, 'google_tokens.json');
const ALGORITHM = 'aes-256-gcm';

function ensureStore() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, '{}', { mode: 0o600 });
  }
}

function getKey(secret) {
  if (!secret) {
    throw new Error('Google token encryption requires GOOGLE_CLIENT_SECRET');
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function readStore() {
  ensureStore();
  const raw = fs.readFileSync(STORE_FILE, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
}

function encryptToken(token, secret) {
  const key = getKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(token), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptToken(payload, secret) {
  const key = getKey(secret);
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const encrypted = Buffer.from(payload.data, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function saveToken(business, token, secret) {
  if (!business) {
    throw new Error('Business identifier is required for token storage');
  }
  const store = readStore();
  store[business] = encryptToken(token, secret);
  writeStore(store);
}

function getToken(business, secret) {
  if (!business) return null;
  const store = readStore();
  const entry = store[business];
  if (!entry) return null;
  try {
    return decryptToken(entry, secret);
  } catch (err) {
    throw new Error(`Failed to decrypt token for business ${business}: ${err.message}`);
  }
}

module.exports = { saveToken, getToken };
