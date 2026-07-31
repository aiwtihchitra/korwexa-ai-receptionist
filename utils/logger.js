'use strict';

/**
 * Minimal, zero-dependency structured logger.
 * - Levels: debug < info < warn < error
 * - ISO timestamps
 * - JSON-friendly output that plays well with Railway / Render log viewers
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function pickLevel() {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] != null ? LEVELS[raw] : LEVELS.info;
}

let currentLevel = pickLevel();

function format(level, msg, meta) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (meta && Object.keys(meta).length) {
    try {
      return `${base} ${JSON.stringify(meta)}`;
    } catch {
      return base;
    }
  }
  return base;
}

function log(level, msg, meta) {
  if (LEVELS[level] < currentLevel) return;
  const line = format(level, msg, meta);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  setLevel: (level) => {
    if (LEVELS[level] != null) currentLevel = LEVELS[level];
  },
  child: (context) => ({
    debug: (msg, meta) => log('debug', msg, { ...context, ...(meta || {}) }),
    info: (msg, meta) => log('info', msg, { ...context, ...(meta || {}) }),
    warn: (msg, meta) => log('warn', msg, { ...context, ...(meta || {}) }),
    error: (msg, meta) => log('error', msg, { ...context, ...(meta || {}) }),
  }),
};

module.exports = logger;
