import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const DEFAULT_STATE_DIR_FALLBACK = join(
  homedir(),
  '.gemini',
  'antigravity',
  'overleaf-live-state'
);

const DEFAULT_MIRROR_ROOT_FALLBACK = join(
  homedir(),
  '.gemini',
  'antigravity',
  'scratch',
  'overleaf'
);

export const STATE_DIR =
  process.env.OVERLEAF_LIVE_STATE_DIR || DEFAULT_STATE_DIR_FALLBACK;

export const DEFAULT_MIRROR_ROOT =
  process.env.OVERLEAF_LIVE_MIRROR_ROOT || DEFAULT_MIRROR_ROOT_FALLBACK;

export const CONFIG_PATH = join(STATE_DIR, 'config.json');
export const SESSION_PATH = join(STATE_DIR, 'session.json');
export const DAEMON_PATH = join(STATE_DIR, 'daemon.json');

export function getStateDir() {
  return process.env.OVERLEAF_LIVE_STATE_DIR || DEFAULT_STATE_DIR_FALLBACK;
}

export function getDefaultMirrorRoot() {
  return process.env.OVERLEAF_LIVE_MIRROR_ROOT || DEFAULT_MIRROR_ROOT_FALLBACK;
}

export function getConfigPath() {
  return join(getStateDir(), 'config.json');
}

export function getSessionPath() {
  return join(getStateDir(), 'session.json');
}

export function getDaemonPath() {
  return join(getStateDir(), 'daemon.json');
}

export function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  return dirPath;
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(filePath, data) {
  const dir = dirname(filePath);
  ensureDir(dir);
  const tmpName = `.${basename(filePath)}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const tmpPath = join(dir, tmpName);
  const serialized = `${JSON.stringify(data, null, 2)}\n`;

  try {
    writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Ignore Windows chmod limitations safely
    }
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeConfig(raw) {
  const obj = isPlainObject(raw) ? raw : {};
  return {
    ...obj,
    bindings: isPlainObject(obj.bindings) ? { ...obj.bindings } : {},
    projects: isPlainObject(obj.projects) ? { ...obj.projects } : {},
  };
}

export function loadConfig() {
  const raw = readJsonSafe(getConfigPath(), null);
  return normalizeConfig(raw);
}

export function saveConfig(cfg) {
  const normalized = normalizeConfig(cfg);
  writeJsonAtomic(getConfigPath(), normalized);
  return normalized;
}

function normalizeSession(raw, fillTimestamp = false) {
  const obj = isPlainObject(raw) ? raw : {};
  const hasValidTs =
    typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt);
  return {
    ...obj,
    baseUrl:
      typeof obj.baseUrl === 'string' && obj.baseUrl.length > 0
        ? obj.baseUrl
        : 'https://www.overleaf.com',
    cookies: isPlainObject(obj.cookies) ? { ...obj.cookies } : {},
    userEmail: typeof obj.userEmail === 'string' ? obj.userEmail : '',
    csrfToken: typeof obj.csrfToken === 'string' ? obj.csrfToken : '',
    updatedAt: hasValidTs ? obj.updatedAt : fillTimestamp ? Date.now() : 0,
  };
}

export function loadSession() {
  const raw = readJsonSafe(getSessionPath(), null);
  return normalizeSession(raw, false);
}

export function saveSession(session) {
  const normalized = normalizeSession(session, true);
  writeJsonAtomic(getSessionPath(), normalized);
  return normalized;
}

export function clearSession() {
  rmSync(getSessionPath(), { force: true });
}

export function readDaemonInfo() {
  const raw = readJsonSafe(getDaemonPath(), null);
  return isPlainObject(raw) ? raw : null;
}

export function writeDaemonInfo(info) {
  const data = isPlainObject(info) ? info : {};
  writeJsonAtomic(getDaemonPath(), data);
  return data;
}

export function clearDaemonInfo() {
  rmSync(getDaemonPath(), { force: true });
}
