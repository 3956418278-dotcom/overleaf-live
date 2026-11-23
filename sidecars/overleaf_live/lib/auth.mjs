/**
 * Overleaf dual-channel authentication & rolling CookieJar manager.
 *
 * Channel A: Direct Cookie / overleaf_session2 / Cookie-Editor JSON / Netscape import.
 * Channel B: Dedicated isolated Chrome `--app` popup captured via CDP
 *            `Network.getCookies` once the user completes login and lands on a
 *            verified authenticated `/project` page (never interacts with login
 *            forms or CAPTCHA challenges).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { getStateDir, loadSession, saveSession, clearSession } from './state_store.mjs';

const DEFAULT_BASE_URL = 'https://www.overleaf.com';
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;
const POPUP_POLL_MS = 800;

export function normalizeBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return DEFAULT_BASE_URL;
  let parsed;
  try {
    parsed = new URL(s.startsWith('http://') || s.startsWith('https://') ? s : `https://${s}`);
  } catch {
    throw new Error(`无效的 Overleaf 地址: ${s}`);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Parses flexible cookie inputs into a `{ name: value }` map.
 * Supports:
 *   1. JSON array from Cookie-Editor / DevTools: `[{ name, value }, ...]` or `{ cookies: [...] }`
 *   2. Flat JSON object: `{ "overleaf_session2": "..." }`
 *   3. Netscape cookies.txt lines
 *   4. HTTP `Cookie:` header (`a=1; b=2`)
 *   5. Bare `overleaf_session2` value (`s%3A...` / `s:...` or single token without `;`)
 */
export function parseCookieInput(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) {
    throw new Error('Cookie 内容不能为空');
  }

  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const out = {};
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.cookies)
          ? parsed.cookies
          : null;
      if (list) {
        for (const item of list) {
          if (item && typeof item.name === 'string' && typeof item.value === 'string' && item.name.trim()) {
            out[item.name.trim()] = item.value;
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && k.trim()) out[k.trim()] = v;
        }
      }
      if (Object.keys(out).length > 0) return out;
    } catch {
      // Fall through to header / bare token parser if not valid JSON.
    }
  }

  // Netscape cookies.txt (7 tab-separated columns)
  if (raw.includes('\t') && raw.includes('\n')) {
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const cols = trimmed.split('\t');
      if (cols.length >= 7 && cols[5]) {
        out[cols[5].trim()] = cols[6] ?? '';
      }
    }
    if (Object.keys(out).length > 0) return out;
  }

  const stripped = raw.replace(/^cookie\s*:\s*/i, '').trim();

  // Bare session value check: `overleaf_session2` signed cookies start with `s%3A` or `s:`,
  // or a single line without `;` where there is no `name=val` key before `s%3A`.
  if (!stripped.includes(';') && (/^s(%3A|:)/i.test(stripped) || !stripped.includes('='))) {
    return { overleaf_session2: stripped };
  }

  const out = {};
  for (const part of stripped.split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const eqIdx = seg.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = seg.slice(0, eqIdx).trim();
    const val = seg.slice(eqIdx + 1).trim();
    if (name && val !== undefined) {
      out[name] = val;
    }
  }

  if (Object.keys(out).length === 0) {
    throw new Error('未能从输入中解析出有效的 Cookie 键值对');
  }
  return out;
}

export class CookieJar {
  #cookies = new Map();
  #baseUrl = DEFAULT_BASE_URL;
  #userEmail = '';
  #csrfToken = '';
  #updatedAt = 0;
  #verified = false;
  #ephemeral = false;

  constructor(initial = null) {
    const ephemeral = Boolean(initial?.ephemeral);
    this.#ephemeral = ephemeral;
    const data = initial || loadSession();
    this.#baseUrl = normalizeBaseUrl(data?.baseUrl || DEFAULT_BASE_URL);
    this.#userEmail = String(data?.userEmail || '');
    this.#csrfToken = String(data?.csrfToken || '');
    this.#updatedAt = Number(data?.updatedAt || 0);
    this.#verified = Boolean(data?.verified || data?.userEmail);
    if (data?.cookies && typeof data.cookies === 'object') {
      for (const [k, v] of Object.entries(data.cookies)) {
        if (k && typeof v === 'string') this.#cookies.set(k, v);
      }
    }
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  set baseUrl(val) {
    this.#baseUrl = normalizeBaseUrl(val);
  }

  get userEmail() {
    return this.#userEmail;
  }

  set userEmail(val) {
    this.#userEmail = String(val || '');
  }

  get csrfToken() {
    return this.#csrfToken;
  }

  set csrfToken(val) {
    this.#csrfToken = String(val || '');
  }

  get updatedAt() {
    return this.#updatedAt;
  }

  get verified() {
    return this.#verified;
  }

  set verified(val) {
    this.#verified = Boolean(val);
  }

  hasSessionCookie() {
    return (
      Boolean(this.#cookies.get('overleaf_session2')) ||
      Boolean(this.#cookies.get('sharelatex.sid')) ||
      Boolean(this.#cookies.get('overleaf_session'))
    );
  }

  isAuthenticated() {
    return this.#verified && this.hasSessionCookie();
  }

  toHeader() {
    const parts = [];
    for (const [k, v] of this.#cookies.entries()) {
      parts.push(`${k}=${v}`);
    }
    return parts.join('; ');
  }

  toObject() {
    return Object.fromEntries(this.#cookies.entries());
  }

  setCookies(map, { replace = false, persist = true } = {}) {
    if (replace) {
      this.#cookies.clear();
      this.#verified = false;
      this.#userEmail = '';
      this.#csrfToken = '';
    }
    for (const [k, v] of Object.entries(map || {})) {
      if (k && typeof v === 'string' && v.length > 0) {
        this.#cookies.set(k, v);
      }
    }
    this.#updatedAt = Date.now();
    if (persist) this.persist();
  }

  absorbSetCookies(headers) {
    if (!headers) return false;
    let rawList = [];
    if (typeof headers.getSetCookie === 'function') {
      rawList = headers.getSetCookie();
    } else if (typeof headers.get === 'function') {
      const single = headers.get('set-cookie');
      if (single) rawList = [single];
    }
    if (!rawList || rawList.length === 0) return false;

    let changed = false;
    for (const line of rawList) {
      const segments = String(line).split(';');
      const first = segments[0]?.trim() || '';
      const eqIdx = first.indexOf('=');
      if (eqIdx <= 0) continue;
      const name = first.slice(0, eqIdx).trim();
      const val = first.slice(eqIdx + 1).trim();

      let expired = val === '';
      for (let i = 1; i < segments.length; i++) {
        const attr = segments[i].trim();
        const lower = attr.toLowerCase();
        if (lower.startsWith('max-age=')) {
          const secs = Number(attr.slice(8).trim());
          if (Number.isFinite(secs) && secs <= 0) expired = true;
        } else if (lower.startsWith('expires=')) {
          const ts = Date.parse(attr.slice(8).trim());
          if (Number.isFinite(ts) && ts <= Date.now()) expired = true;
        }
      }

      if (expired) {
        if (this.#cookies.delete(name)) changed = true;
      } else if (this.#cookies.get(name) !== val) {
        this.#cookies.set(name, val);
        changed = true;
      }
    }

    if (changed) {
      this.#updatedAt = Date.now();
      this.persist();
    }
    return changed;
  }

  persist() {
    if (this.#ephemeral) return;
    saveSession({
      baseUrl: this.#baseUrl,
      cookies: this.toObject(),
      userEmail: this.#userEmail,
      csrfToken: this.#csrfToken,
      verified: this.#verified,
      updatedAt: this.#updatedAt || Date.now(),
    });
  }

  clear() {
    this.#cookies.clear();
    this.#userEmail = '';
    this.#csrfToken = '';
    this.#updatedAt = 0;
    this.#verified = false;
    if (!this.#ephemeral) clearSession();
  }
}

export function findChromeBinary() {
  const candidates = [
    process.env.OVERLEAF_CHROME_PATH || '',
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  if (process.platform === 'win32') {
    for (const hive of ['HKCU', 'HKLM']) {
      try {
        const out = execFileSync(
          'reg.exe',
          ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, '/ve'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
        );
        const m = out.match(/REG_SZ\s+(.+\.exe)/i);
        const regPath = m ? m[1].trim().replace(/^"|"$/g, '') : '';
        if (regPath && existsSync(regPath)) return regPath;
      } catch {
        // Ignore missing registry key
      }
    }
  }
  return '';
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function cdpRequest(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`CDP ${method} timeout`));
    }, 5000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id === 1) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
          else resolve(msg.result || {});
        }
      } catch {
        // Ignore unrelated CDP events
      }
    };
    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(new Error(err?.message || 'CDP socket error'));
    };
  });
}

function isAuthenticatedProjectUrl(urlStr, baseUrl) {
  try {
    const u = new URL(urlStr);
    const base = new URL(baseUrl);
    if (u.host !== base.host) return false;
    const p = u.pathname.toLowerCase();
    if (p.includes('/login') || p.includes('/register') || p.includes('/oauth')) return false;
    return p === '/project' || p.startsWith('/project/');
  } catch {
    return false;
  }
}

let activePopup = null;

export function clearBrowserAuthProfile() {
  for (const name of ['chrome-auth-profile', 'auth-profile']) {
    try {
      rmSync(join(getStateDir(), name), { recursive: true, force: true });
    } catch {}
  }
}

function killPopupProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    } catch {}
  }
  try { child.kill(); } catch {}
}

export function isLoginPopupActive() {
  return Boolean(activePopup);
}

export function cancelLoginPopup() {
  if (!activePopup) return false;
  const popup = activePopup;
  activePopup = null;
  popup.cancelled = true;
  clearTimeout(popup.pollTimer);
  clearTimeout(popup.deadlineTimer);
  killPopupProcess(popup.child);
  return true;
}

/**
 * Launches a dedicated isolated Chrome `--app` window at `${baseUrl}/login`
 * so the user can sign in (including Google / SSO / CAPTCHA). Once all three
 * authentication gates pass (CDP `/project` URL + committed authenticated DOM
 * metadata + server-side `verifySession` verification), reads cookies via CDP
 * and closes the popup cleanly.
 */
export async function launchBrowserLoginPopup({
  baseUrl = DEFAULT_BASE_URL,
  headless = false,
  verifySession,
  onSuccess,
  onError,
  onClose,
} = {}) {
  if (activePopup) {
    return { started: true, alreadyActive: true, port: activePopup.port };
  }

  const exe = findChromeBinary();
  if (!exe) {
    throw new Error('未在本机检测到 Google Chrome，请安装 Chrome 或使用 Cookie 粘贴方式登录。');
  }

  const normalizedBase = normalizeBaseUrl(baseUrl);
  const port = await getFreePort();
  const profileDir = join(getStateDir(), 'chrome-auth-profile');
  mkdirSync(profileDir, { recursive: true });

  const loginUrl = `${normalizedBase}/login`;
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=560,740',
  ];
  if (headless) {
    args.push('--headless=new', '--disable-gpu', loginUrl);
  } else {
    args.push(`--app=${loginUrl}`);
  }

  const child = spawn(exe, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: Boolean(headless),
  });

  const popup = {
    child,
    port,
    baseUrl: normalizedBase,
    cancelled: false,
    finished: false,
    pollTimer: null,
    deadlineTimer: null,
  };
  activePopup = popup;

  const cleanup = () => {
    if (activePopup === popup) activePopup = null;
    clearTimeout(popup.pollTimer);
    clearTimeout(popup.deadlineTimer);
  };

  child.on('exit', () => {
    if (!popup.finished && !popup.cancelled) {
      popup.finished = true;
      cleanup();
      onClose?.();
    }
  });

  popup.deadlineTimer = setTimeout(() => {
    if (popup.finished || popup.cancelled) return;
    popup.finished = true;
    cleanup();
    killPopupProcess(child);
    onError?.(new Error('登录窗口已超时（5 分钟），请重试或直接粘贴 Cookie。'));
  }, POPUP_TIMEOUT_MS);

  const poll = async () => {
    if (popup.finished || popup.cancelled) return;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const targets = await res.json();
        // Gate 1: Target URL looks like an authenticated `/project` page on the same host.
        const pageTarget = Array.isArray(targets)
          ? targets.find(
              (t) =>
                t.type === 'page' &&
                t.webSocketDebuggerUrl &&
                isAuthenticatedProjectUrl(t.url, normalizedBase)
            )
          : null;

        if (pageTarget) {
          // Gate 2: Confirm committed DOM metadata in the page belongs to a signed-in user.
          const evalRes = await cdpRequest(pageTarget.webSocketDebuggerUrl, 'Runtime.evaluate', {
            expression: `JSON.stringify({
              href: String(location.href || ''),
              readyState: String(document.readyState || ''),
              userId: document.querySelector('meta[name="ol-user_id"]')?.getAttribute('content') || '',
              userEmail: document.querySelector('meta[name="ol-usersEmail"]')?.getAttribute('content') || '',
              hasProjectsBlob: Boolean(
                document.querySelector('meta[name="ol-prefetchedProjectsBlob"]') ||
                document.querySelector('script#data')
              )
            })`,
            returnByValue: true,
          });
          let domInfo = null;
          if (typeof evalRes?.result?.value === 'string') {
            try {
              domInfo = JSON.parse(evalRes.result.value);
            } catch {}
          }

          const domAuthenticated = Boolean(
            domInfo &&
              isAuthenticatedProjectUrl(domInfo.href, normalizedBase) &&
              (domInfo.readyState === 'interactive' || domInfo.readyState === 'complete') &&
              (domInfo.userId || domInfo.userEmail || domInfo.hasProjectsBlob)
          );

          if (domAuthenticated) {
            const cookieRes = await cdpRequest(pageTarget.webSocketDebuggerUrl, 'Network.getCookies', {
              urls: [normalizedBase],
            });
            const cookiesList = Array.isArray(cookieRes?.cookies) ? cookieRes.cookies : [];
            const cookieMap = {};
            for (const c of cookiesList) {
              if (c?.name && typeof c.value === 'string') {
                cookieMap[c.name] = c.value;
              }
            }

            if (cookieMap.overleaf_session2 || cookieMap['sharelatex.sid'] || cookieMap.overleaf_session) {
              // Gate 3: Server-side HTTP verification BEFORE closing Chrome or marking success.
              const verifiedInfo = verifySession ? await verifySession(cookieMap) : null;
              if (popup.finished || popup.cancelled) return;
              popup.finished = true;
              cleanup();
              // Close the browser gracefully via CDP, with kill fallback.
              cdpRequest(pageTarget.webSocketDebuggerUrl, 'Browser.close').catch(() => {});
              setTimeout(() => {
                killPopupProcess(child);
              }, 1200);
              await onSuccess?.(cookieMap, verifiedInfo);
              return;
            }
          }
        }
      }
    } catch {
      // Browser CDP may still be booting, or session verification rejected anonymous cookies.
    }

    if (!popup.finished && !popup.cancelled) {
      popup.pollTimer = setTimeout(poll, POPUP_POLL_MS);
    }
  };

  popup.pollTimer = setTimeout(poll, 1000);
  return { started: true, alreadyActive: false, port };
}
