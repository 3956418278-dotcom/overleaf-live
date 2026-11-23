/**
 * Overleaf HTTP REST + Socket.IO v0.9 Realtime WebSocket Client.
 *
 * Pure Node.js v24 built-ins (`fetch`, `WebSocket`, `FormData`, `Blob`).
 * Handles:
 *  - Redirect-aware HTTP requests that absorb rolling `Set-Cookie` headers
 *  - Sticky load balancer (`GCLB`) preflight + CSRF token extraction
 *  - Dual `joinProjectResponse` / legacy `joinProject` ack handshake
 *  - Latin-1 stuffed UTF-8 (`decodeOverleafLine`) decoding on `joinDoc`
 *  - Per-doc serialized ShareJS `text0` OT send queue + co-author transform
 *  - Cloud compile (`POST /project/<id>/compile`) & artifact download
 */
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { applyOp, diffToOp, normalizeNewlines, transformX } from './ot_diff.mjs';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class AuthError extends Error {
  constructor(message = 'Overleaf 会话未登录或已失效，请重新登录。') {
    super(message);
    this.name = 'AuthError';
  }
}

export function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseMetaAttributes(tagHtml) {
  const attrs = {};
  const attrRe = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = attrRe.exec(tagHtml)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return attrs;
}

export function extractMetaTag(html, metaName) {
  const target = metaName.toLowerCase();
  const metaRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const attrs = parseMetaAttributes(m[0]);
    if ((attrs.name || '').toLowerCase() === target && attrs.content !== undefined) {
      return decodeHtmlEntities(attrs.content);
    }
  }
  return '';
}

/**
 * Overleaf's `joinDoc` sometimes returns UTF-8 bytes stored inside Latin-1 JS strings
 * (every code unit <= 0xFF, with bytes >= 0x80). Decode safely back to UTF-8.
 */
export function decodeOverleafLine(line) {
  const s = String(line ?? '');
  let hasHighLatin1 = false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0xff) return s; // Already proper multi-byte Unicode
    if (code >= 0x80) hasHighLatin1 = true;
  }
  if (!hasHighLatin1) return s;
  try {
    const bytes = Buffer.from(s, 'latin1');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

export class OverleafHttp {
  constructor(jar) {
    this.jar = jar;
  }

  get baseUrl() {
    return this.jar.baseUrl;
  }

  async request(pathOrUrl, { method = 'GET', headers = {}, body, timeoutMs = 30_000, expectJson = false } = {}) {
    if (!this.jar.hasSessionCookie()) {
      throw new AuthError();
    }

    let currentUrl = new URL(pathOrUrl, this.baseUrl).href;
    let currentMethod = method.toUpperCase();
    let currentBody = body;

    for (let hop = 0; hop < 6; hop++) {
      const reqHeaders = new Headers(headers);
      const cookieHeader = this.jar.toHeader();
      if (cookieHeader) reqHeaders.set('Cookie', cookieHeader);
      if (!reqHeaders.has('User-Agent')) reqHeaders.set('User-Agent', USER_AGENT);
      if (!reqHeaders.has('Origin') && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
        reqHeaders.set('Origin', this.baseUrl);
      }

      const res = await fetch(currentUrl, {
        method: currentMethod,
        headers: reqHeaders,
        body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : currentBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });

      this.jar.absorbSetCookies(res.headers);

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`HTTP ${res.status} redirect without location`);
        const nextUrl = new URL(loc, currentUrl).href;
        const parsedNext = new URL(nextUrl);
        if (parsedNext.pathname.toLowerCase().includes('/login')) {
          throw new AuthError('Overleaf 登录会话已过期，请重新登录。');
        }
        currentUrl = nextUrl;
        if (res.status === 301 || res.status === 302 || res.status === 303) {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        continue;
      }

      if (res.status === 401) {
        throw new AuthError('Overleaf 返回 401 Unauthorized，请更新登录会话。');
      }
      if (res.status === 403) {
        const text = await res.text();
        if (text.toLowerCase().includes('csrf')) {
          throw new Error(`CSRF 校验失败 (403): ${text.slice(0, 160)}`);
        }
        throw new AuthError(`无权限访问或会话无效 (403): ${text.slice(0, 160)}`);
      }

      if (expectJson) {
        const raw = await res.text();
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} on ${currentUrl}: ${raw.slice(0, 240)}`);
        }
        try {
          return JSON.parse(raw);
        } catch {
          throw new Error(`Overleaf 返回了非 JSON 响应: ${raw.slice(0, 200)}`);
        }
      }

      return res;
    }

    throw new Error(`Too many redirects while requesting ${pathOrUrl}`);
  }

  async verifyAndListProjects() {
    const res = await this.request('/project', { method: 'GET' });
    const html = await res.text();
    if (!res.ok) {
      throw new Error(`拉取 /project 失败 (HTTP ${res.status})`);
    }
    const csrfToken = extractMetaTag(html, 'ol-csrfToken');
    const userEmail = extractMetaTag(html, 'ol-usersEmail');
    const userId = extractMetaTag(html, 'ol-user_id');
    const blobRaw = extractMetaTag(html, 'ol-prefetchedProjectsBlob');
    const hasDataScript = /<script[^>]*id=["']data["'][^>]*>/i.test(html);
    if (
      html.includes('name="ol-login"') ||
      (!userEmail && !userId && !blobRaw && !hasDataScript)
    ) {
      throw new AuthError('Cookie 未生效或已被登出，请重新登录。');
    }

    if (csrfToken) this.jar.csrfToken = csrfToken;
    if (userEmail) this.jar.userEmail = userEmail;
    this.jar.verified = true;
    this.jar.persist();

    let projects = [];
    if (blobRaw) {
      try {
        const parsed = JSON.parse(blobRaw);
        if (Array.isArray(parsed?.projects)) projects = parsed.projects;
        else if (Array.isArray(parsed)) projects = parsed;
      } catch {
        // Ignore malformed meta blob and try fallback
      }
    }

    if (projects.length === 0) {
      const scriptMatch = html.match(/<script[^>]*id=["']data["'][^>]*>([\s\S]*?)<\/script>/i);
      if (scriptMatch) {
        try {
          const parsed = JSON.parse(scriptMatch[1]);
          if (Array.isArray(parsed?.projects)) projects = parsed.projects;
        } catch {
          // Ignore
        }
      }
    }

    if (projects.length === 0) {
      try {
        const jsonRes = await this.request('/user/projects', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          expectJson: true,
        });
        if (Array.isArray(jsonRes?.projects)) projects = jsonRes.projects;
      } catch {
        // Optional endpoint on newer instances
      }
    }

    return {
      authenticated: true,
      userEmail: this.jar.userEmail,
      csrfToken: this.jar.csrfToken,
      projects: projects.map((p) => ({
        id: String(p.id || p._id || ''),
        name: String(p.name || 'Untitled Project'),
        lastUpdated: p.lastUpdated || '',
        accessLevel: p.accessLevel || 'owner',
        archived: Boolean(p.archived),
        trashed: Boolean(p.trashed),
      })).filter((p) => p.id && !p.trashed),
    };
  }

  /**
   * Fetches `/project/<projectId>` to refresh `csrfToken` AND obtain the sticky
   * load-balancer `GCLB` cookie before opening the Socket.IO connection.
   */
  async fetchProjectPageCsrf(projectId) {
    const res = await this.request(`/project/${encodeURIComponent(projectId)}`, { method: 'GET' });
    const html = await res.text();
    if (!res.ok) {
      throw new Error(`无法打开项目 ${projectId} (HTTP ${res.status})`);
    }
    const csrfToken = extractMetaTag(html, 'ol-csrfToken');
    const userEmail = extractMetaTag(html, 'ol-usersEmail');
    if (csrfToken) this.jar.csrfToken = csrfToken;
    if (userEmail) this.jar.userEmail = userEmail;
    this.jar.persist();
    return { csrfToken: this.jar.csrfToken, userEmail: this.jar.userEmail };
  }

  async #ensureCsrf(projectId) {
    if (!this.jar.csrfToken && projectId) {
      await this.fetchProjectPageCsrf(projectId);
    }
    return this.jar.csrfToken;
  }

  async createDoc(projectId, parentFolderId, name) {
    const csrf = await this.#ensureCsrf(projectId);
    return this.request(`/project/${encodeURIComponent(projectId)}/doc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Csrf-Token': csrf,
        Referer: `${this.baseUrl}/project/${encodeURIComponent(projectId)}`,
      },
      body: JSON.stringify({ name, parent_folder_id: parentFolderId }),
      expectJson: true,
    });
  }

  async createFolder(projectId, parentFolderId, name) {
    const csrf = await this.#ensureCsrf(projectId);
    return this.request(`/project/${encodeURIComponent(projectId)}/folder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Csrf-Token': csrf,
        Referer: `${this.baseUrl}/project/${encodeURIComponent(projectId)}`,
      },
      body: JSON.stringify({ name, parent_folder_id: parentFolderId }),
      expectJson: true,
    });
  }

  async uploadFile(projectId, folderId, fileName, buffer, mimeType = 'application/octet-stream') {
    const csrf = await this.#ensureCsrf(projectId);
    const form = new FormData();
    form.set('relativePath', 'null');
    form.set('name', fileName);
    form.set('type', mimeType);
    form.set('qqfile', new Blob([buffer], { type: mimeType }), fileName);

    return this.request(
      `/project/${encodeURIComponent(projectId)}/upload?folder_id=${encodeURIComponent(folderId)}`,
      {
        method: 'POST',
        headers: {
          'X-Csrf-Token': csrf,
          Referer: `${this.baseUrl}/project/${encodeURIComponent(projectId)}`,
        },
        body: form,
        timeoutMs: 60_000,
        expectJson: true,
      }
    );
  }

  async downloadFile(projectId, fileId) {
    const endpoint = `/project/${encodeURIComponent(projectId)}/file/${encodeURIComponent(fileId)}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let res;
      try {
        res = await this.request(endpoint, { method: 'GET', timeoutMs: 60_000 });
        if (res.ok) {
          return Buffer.from(await res.arrayBuffer());
        }
        const err = new Error(`下载附件失败 (HTTP ${res.status})`);
        err.status = res.status;
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= 2) {
          throw err;
        }
        const retrySec = parseFloat(res.headers.get('retry-after') || '');
        const waitMs =
          Number.isFinite(retrySec) && retrySec > 0
            ? Math.min(Math.ceil(retrySec * 1000), 4000)
            : attempt === 0
              ? 500
              : 1200;
        await delay(waitMs);
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (typeof err?.status === 'number' && err.status !== 429 && err.status < 500) {
          throw err;
        }
        if (attempt >= 2) throw err;
        // Wait briefly on transient network errors without an HTTP status
        if (!err?.status) {
          await delay(attempt === 0 ? 500 : 1200);
        }
      }
    }
    throw new Error('下载附件失败');
  }

  async deleteEntity(projectId, entityType, entityId) {
    const csrf = await this.#ensureCsrf(projectId);
    const res = await this.request(
      `/project/${encodeURIComponent(projectId)}/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
      {
        method: 'DELETE',
        headers: {
          'X-Csrf-Token': csrf,
          Referer: `${this.baseUrl}/project/${encodeURIComponent(projectId)}`,
        },
      }
    );
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new Error(`删除 ${entityType} 失败 (HTTP ${res.status}): ${text.slice(0, 160)}`);
    }
    return true;
  }

  async setRootDoc(projectId, rootDocId) {
    const csrf = await this.#ensureCsrf(projectId);
    const sendSettings = (payload) =>
      this.request(`/project/${encodeURIComponent(projectId)}/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Csrf-Token': csrf,
          Referer: `${this.baseUrl}/project/${encodeURIComponent(projectId)}`,
        },
        body: JSON.stringify(payload),
      });

    let res = await sendSettings({ rootDocId });
    if (res.status === 400) {
      const text = await res.text();
      if (/Unrecognized key.*rootDocId/i.test(text)) {
        res = await sendSettings({ rootDoc_id: rootDocId });
      } else {
        throw new Error(`切换 Overleaf 主文档失败 (HTTP 400): ${text.slice(0, 160)}`);
      }
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`切换 Overleaf 主文档失败 (HTTP ${res.status}): ${text.slice(0, 160)}`);
    }
    return true;
  }

  async compile(projectId, rootDocId, { draft = false, incremental = true } = {}) {
    const csrf = await this.#ensureCsrf(projectId);
    const payload = {
      draft: Boolean(draft),
      check: 'silent',
      incrementalCompilesEnabled: Boolean(incremental),
    };
    if (rootDocId) payload.rootDoc_id = rootDocId;

    return this.request(`/project/${encodeURIComponent(projectId)}/compile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Csrf-Token': csrf,
        Referer: `${this.baseUrl}/project/${encodeURIComponent(projectId)}`,
      },
      body: JSON.stringify(payload),
      timeoutMs: 90_000,
      expectJson: true,
    });
  }

  async downloadBuildArtifact(artifactUrl, { clsiServerId = '' } = {}) {
    let targetUrl = String(artifactUrl || '');
    if (clsiServerId && targetUrl && !/[?&]clsiserverid=/i.test(targetUrl)) {
      targetUrl += `${targetUrl.includes('?') ? '&' : '?'}clsiserverid=${encodeURIComponent(clsiServerId)}`;
    }
    const res = await this.request(targetUrl, { method: 'GET', timeoutMs: 60_000 });
    if (!res.ok) {
      const err = new Error(`下载编译产物失败 (HTTP ${res.status}): ${artifactUrl}`);
      err.status = res.status;
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

/**
 * Overleaf Socket.IO v0.9 realtime WebSocket client.
 * Manages `joinProject` / `joinProjectResponse`, `joinDoc`, serialized per-doc
 * `applyOtUpdate`, remote co-author `otUpdateApplied`, and live tree events.
 */
export class OverleafRealtimeSession extends EventEmitter {
  #http;
  #projectId;
  #ws = null;
  #closed = false;
  #packetSeq = 1;
  #pendingAcks = new Map();
  #docs = new Map(); // docId -> { docId, version, text, desiredText, inFlight, joinPromise }
  #reconnectAttempts = 0;
  #reconnectTimer = null;
  #joinFallbackTimer = null;
  #joined = false;

  publicId = '';
  project = null;
  permissionsLevel = '';
  status = 'disconnected'; // disconnected | connecting | connected | reconnecting | error

  constructor({ http, projectId }) {
    super();
    this.#http = http;
    this.#projectId = projectId;
  }

  get projectId() {
    return this.#projectId;
  }

  getDocState(docId) {
    return this.#docs.get(docId) || null;
  }

  async connect() {
    this.#closed = false;
    return this.#openSocket();
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#joinFallbackTimer);
    this.#rejectAllAcks(new Error('Realtime session closed'));
    if (this.#ws) {
      try { this.#ws.close(); } catch {}
      this.#ws = null;
    }
    this.#setStatus('disconnected');
  }

  #setStatus(next) {
    if (this.status === next) return;
    this.status = next;
    this.emit('status', next);
  }

  async #openSocket() {
    this.#setStatus(this.#reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    this.#joined = false;

    await this.#http.fetchProjectPageCsrf(this.#projectId);

    const handshakeUrl = `/socket.io/1/?projectId=${encodeURIComponent(this.#projectId)}&t=${Date.now()}`;
    const hsRes = await this.#http.request(handshakeUrl, { method: 'GET' });
    const hsText = await hsRes.text();
    if (!hsRes.ok || !hsText.includes(':')) {
      throw new Error(`Socket.IO 握手失败 (HTTP ${hsRes.status}): ${hsText.slice(0, 120)}`);
    }

    const sessionId = hsText.split(':')[0].trim();
    const base = new URL(this.#http.baseUrl);
    const wsProto = base.protocol === 'http:' ? 'ws:' : 'wss:';
    const wsUrl = `${wsProto}//${base.host}/socket.io/1/websocket/${encodeURIComponent(sessionId)}?projectId=${encodeURIComponent(this.#projectId)}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const failEarly = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      const ws = new WebSocket(wsUrl, {
        headers: {
          Cookie: this.#http.jar.toHeader(),
          Origin: this.#http.baseUrl,
          'User-Agent': USER_AGENT,
        },
      });
      this.#ws = ws;

      const joinTimeout = setTimeout(() => {
        failEarly(new Error('Overleaf joinProject 超时'));
        try { ws.close(); } catch {}
      }, 20_000);

      const finishJoin = (payload) => {
        clearTimeout(joinTimeout);
        clearTimeout(this.#joinFallbackTimer);
        this.#joined = true;
        this.#reconnectAttempts = 0;
        if (payload?.publicId) this.publicId = String(payload.publicId);
        if (payload?.project) this.project = payload.project;
        if (payload?.permissionsLevel) this.permissionsLevel = String(payload.permissionsLevel);
        this.#setStatus('connected');
        this.emit('joined', {
          publicId: this.publicId,
          project: this.project,
          permissionsLevel: this.permissionsLevel,
        });
        if (!settled) {
          settled = true;
          resolve(this.project);
        }
      };

      ws.onmessage = (event) => {
        const raw = String(event.data || '');
        this.#handlePacket(raw, finishJoin);
      };

      ws.onerror = (ev) => {
        const err = new Error(ev?.message || 'WebSocket connection error');
        this.emit('error', err);
        failEarly(err);
      };

      ws.onclose = () => {
        clearTimeout(joinTimeout);
        clearTimeout(this.#joinFallbackTimer);
        this.#rejectAllAcks(new Error('WebSocket closed'));
        // Reset inFlight markers so pending desiredText can be cleanly re-diffed after reconnect.
        for (const doc of this.#docs.values()) {
          doc.inFlight = null;
          doc.joinPromise = null;
        }
        if (this.#ws === ws) this.#ws = null;
        if (!settled) {
          failEarly(new Error('WebSocket closed before joinProject completed'));
        }
        if (!this.#closed) {
          this.#scheduleReconnect();
        }
      };
    });
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectAttempts += 1;
    this.#setStatus('reconnecting');
    const delayMs = Math.min(30_000, 1000 * Math.pow(2, Math.min(5, this.#reconnectAttempts - 1)));
    this.#reconnectTimer = setTimeout(() => {
      if (this.#closed) return;
      this.#openSocket()
        .then(() => this.emit('reconnected'))
        .catch((err) => {
          this.emit('error', err);
          if (!this.#closed && !(err instanceof AuthError)) {
            this.#scheduleReconnect();
          } else if (err instanceof AuthError) {
            this.#setStatus('error');
          }
        });
    }, delayMs);
  }

  #sendRaw(packet) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error('Overleaf WebSocket 未连接');
    }
    this.#ws.send(packet);
  }

  #emitWithAck(name, args, timeoutMs = 20_000) {
    const id = this.#packetSeq++;
    const payload = JSON.stringify({ name, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingAcks.delete(id);
        reject(new Error(`Socket.IO ack timeout for ${name}`));
      }, timeoutMs);

      this.#pendingAcks.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.#sendRaw(`5:${id}+::${payload}`);
      } catch (err) {
        clearTimeout(timer);
        this.#pendingAcks.delete(id);
        reject(err);
      }
    });
  }

  #rejectAllAcks(err) {
    for (const entry of this.#pendingAcks.values()) {
      entry.reject(err);
    }
    this.#pendingAcks.clear();
  }

  #handlePacket(raw, finishJoin) {
    if (!raw) return;

    // Socket.IO v0.9 framing: <type>:<id?>:<endpoint?>:<data?>
    if (raw.startsWith('2::')) {
      try { this.#sendRaw('2::'); } catch {}
      return;
    }

    if (raw.startsWith('0::')) {
      try { this.#ws?.close(); } catch {}
      return;
    }

    if (raw.startsWith('1::')) {
      // Modern Overleaf auto-pushes `joinProjectResponse` right after `1::`;
      // legacy instances expect an explicit `joinProject` event.
      clearTimeout(this.#joinFallbackTimer);
      this.#joinFallbackTimer = setTimeout(() => {
        if (this.#joined || this.#closed) return;
        this.#emitWithAck('joinProject', [{ project_id: this.#projectId }])
          .then((ackArgs) => {
            if (!Array.isArray(ackArgs)) return;
            const [err, project, permissionsLevel] = ackArgs;
            if (err) {
              this.emit('error', new Error(typeof err === 'string' ? err : JSON.stringify(err)));
              return;
            }
            if (project) finishJoin({ project, permissionsLevel });
          })
          .catch((err) => this.emit('error', err));
      }, 450);
      return;
    }

    const firstColon = raw.indexOf(':');
    if (firstColon < 0) return;
    const type = raw.slice(0, firstColon);
    const secondColon = raw.indexOf(':', firstColon + 1);
    if (secondColon < 0) return;
    const thirdColon = raw.indexOf(':', secondColon + 1);
    if (thirdColon < 0) return;
    const dataPart = raw.slice(thirdColon + 1);

    if (type === '6') {
      const plusIdx = dataPart.indexOf('+');
      if (plusIdx < 0) return;
      const ackId = Number(dataPart.slice(0, plusIdx));
      const argStr = dataPart.slice(plusIdx + 1);
      const pending = this.#pendingAcks.get(ackId);
      if (!pending) return;
      this.#pendingAcks.delete(ackId);
      try {
        pending.resolve(argStr ? JSON.parse(argStr) : []);
      } catch {
        pending.resolve([]);
      }
      return;
    }

    if (type === '5') {
      let msg;
      try {
        msg = JSON.parse(dataPart);
      } catch {
        return;
      }
      this.#handleEvent(msg?.name, Array.isArray(msg?.args) ? msg.args : [], finishJoin);
      return;
    }

    if (type === '7') {
      this.emit('error', new Error(`Socket.IO error: ${dataPart}`));
    }
  }

  #handleEvent(name, args, finishJoin) {
    if (!name) return;

    if (name === 'joinProjectResponse') {
      finishJoin(args[0] || {});
      return;
    }

    if (name === 'connectionAccepted') {
      if (args[0]) this.publicId = String(args[0]);
      return;
    }

    if (name === 'connectionRejected') {
      this.#setStatus('error');
      this.emit('error', new AuthError(`Overleaf 拒绝连接: ${JSON.stringify(args[0] || {})}`));
      return;
    }

    if (name === 'otUpdateApplied') {
      this.#handleOtUpdateApplied(args[0]);
      return;
    }

    if (name === 'otUpdateError') {
      const errObj = args[0] || {};
      const docId = errObj.doc || errObj.doc_id;
      this.emit('error', new Error(`OT update error (${docId || 'unknown'}): ${errObj.error || JSON.stringify(errObj)}`));
      if (docId) {
        const doc = this.#docs.get(docId);
        if (doc) doc.inFlight = null;
        this.joinDoc(docId, { force: true }).catch((e) => this.emit('error', e));
      }
      return;
    }

    // Overleaf uses historical `recive*` spelling in server events; accept both spellings.
    if (name === 'reciveNewDoc' || name === 'receiveNewDoc') {
      this.emit('entityCreated', { kind: 'doc', parentFolderId: args[0], entity: args[1] });
    } else if (name === 'reciveNewFile' || name === 'receiveNewFile') {
      this.emit('entityCreated', { kind: 'file', parentFolderId: args[0], entity: args[1] });
    } else if (name === 'reciveNewFolder' || name === 'receiveNewFolder') {
      this.emit('entityCreated', { kind: 'folder', parentFolderId: args[0], entity: args[1] });
    } else if (name === 'reciveEntityRename' || name === 'receiveEntityRename') {
      this.emit('entityRenamed', { entityId: args[0], newName: args[1] });
    } else if (name === 'reciveEntityDelete' || name === 'receiveEntityDelete') {
      this.#docs.delete(args[0]);
      this.emit('entityDeleted', { entityId: args[0] });
    } else if (name === 'reciveEntityMove' || name === 'receiveEntityMove') {
      this.emit('entityMoved', { entityId: args[0], folderId: args[1] });
    } else if (name === 'forceDisconnect') {
      this.emit('error', new Error(`Overleaf forceDisconnect: ${args[0] || ''}`));
    }
  }

  async joinDoc(docId, { force = false } = {}) {
    let doc = this.#docs.get(docId);
    if (!force && doc?.joinPromise) return doc.joinPromise;
    if (!force && doc && doc.version !== null && doc.text !== null) return doc;

    if (!doc) {
      doc = {
        docId,
        version: null,
        text: null,
        desiredText: null,
        inFlight: null,
        joinPromise: null,
      };
      this.#docs.set(docId, doc);
    }

    const promise = (async () => {
      const ack = await this.#emitWithAck('joinDoc', [docId, { encodeRanges: true }]);
      const [err, docLines, version] = Array.isArray(ack) ? ack : [null, [], 0];
      if (err) {
        throw new Error(`joinDoc(${docId}) 失败: ${typeof err === 'string' ? err : JSON.stringify(err)}`);
      }
      const decoded = Array.isArray(docLines)
        ? docLines.map((l) => decodeOverleafLine(l)).join('\n')
        : '';
      const normalized = normalizeNewlines(decoded);
      doc.text = normalized;
      if (doc.desiredText === null) doc.desiredText = normalized;
      doc.version = Number(version) || 0;
      doc.joinPromise = null;
      return doc;
    })();

    doc.joinPromise = promise;
    try {
      return await promise;
    } catch (err) {
      doc.joinPromise = null;
      throw err;
    }
  }

  /**
   * Queues a full-text replacement for `docId` into Overleaf via serialized ShareJS OT ops.
   */
  async sendDocEdit(docId, newText) {
    const doc = await this.joinDoc(docId);
    const normalized = normalizeNewlines(newText);
    doc.desiredText = normalized;
    return this.#pumpDocQueue(doc);
  }

  async #pumpDocQueue(doc) {
    if (doc.inFlight) {
      return doc.inFlight.donePromise;
    }
    if (doc.desiredText === null || doc.desiredText === doc.text) {
      return { synced: true, version: doc.version };
    }

    const targetText = doc.desiredText;
    const op = diffToOp(doc.text, targetText);
    if (op.length === 0) {
      doc.text = targetText;
      return { synced: true, version: doc.version };
    }

    const sentV = doc.version;
    let resolveDone;
    let rejectDone;
    const donePromise = new Promise((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });

    const flight = {
      op,
      sentV,
      targetText,
      echoApplied: false,
      donePromise,
      resolveDone,
      rejectDone,
    };
    doc.inFlight = flight;

    try {
      const meta = this.publicId ? { source: this.publicId } : {};
      const ack = await this.#emitWithAck('applyOtUpdate', [
        doc.docId,
        { doc: doc.docId, op, v: sentV, meta },
      ]);
      const ackErr = Array.isArray(ack) ? ack[0] : null;
      if (ackErr) {
        throw new Error(typeof ackErr === 'string' ? ackErr : JSON.stringify(ackErr));
      }

      if (!flight.echoApplied) {
        doc.text = applyOp(doc.text, flight.op);
        doc.version = Math.max(doc.version, sentV + 1);
        flight.echoApplied = true;
      }

      if (doc.inFlight === flight) doc.inFlight = null;
      resolveDone({ synced: true, version: doc.version });

      // If more local edits arrived while in flight, pump immediately.
      if (doc.desiredText !== doc.text) {
        await this.#pumpDocQueue(doc);
      }
      return { synced: true, version: doc.version };
    } catch (err) {
      if (doc.inFlight === flight) doc.inFlight = null;
      rejectDone(err);
      throw err;
    }
  }

  #handleOtUpdateApplied(update) {
    if (!update || typeof update !== 'object') return;
    const docId = update.doc || update.doc_id;
    const doc = this.#docs.get(docId);
    if (!doc || doc.text === null) return;

    const v = Number(update.v);
    if (Number.isFinite(v) && v < doc.version) return;

    const isOwnEcho =
      Boolean(this.publicId && update.meta?.source && update.meta.source === this.publicId) ||
      (!update.op && doc.inFlight && v === doc.inFlight.sentV);

    if (isOwnEcho) {
      if (doc.inFlight && !doc.inFlight.echoApplied) {
        try {
          doc.text = applyOp(doc.text, doc.inFlight.op);
        } catch {
          this.joinDoc(docId, { force: true }).catch((e) => this.emit('error', e));
          return;
        }
        doc.inFlight.echoApplied = true;
      }
      if (Number.isFinite(v)) doc.version = Math.max(doc.version, v + 1);
      return;
    }

    const serverOp = Array.isArray(update.op) ? update.op : [];
    if (serverOp.length === 0) {
      if (Number.isFinite(v)) doc.version = Math.max(doc.version, v + 1);
      return;
    }

    try {
      const nextBase = applyOp(doc.text, serverOp);
      doc.text = nextBase;
      if (Number.isFinite(v)) doc.version = v + 1;

      if (doc.inFlight) {
        // Transform our un-acked in-flight op against the collaborator's op so when
        // our ack lands (or desiredText re-diffs), the collaborator's edit isn't lost.
        const [transformedInFlight, transformedServer] = transformX(
          doc.inFlight.op,
          serverOp,
          'left'
        );
        doc.inFlight.op = transformedInFlight;
        if (doc.desiredText === doc.inFlight.targetText) {
          doc.desiredText = applyOp(doc.desiredText, transformedServer);
          doc.inFlight.targetText = doc.desiredText;
        }
      } else {
        doc.desiredText = nextBase;
      }

      this.emit('docUpdate', { docId, text: nextBase, version: doc.version, update });
    } catch {
      this.joinDoc(docId, { force: true })
        .then((fresh) => {
          this.emit('docUpdate', { docId, text: fresh.text, version: fresh.version, update });
        })
        .catch((e) => this.emit('error', e));
    }
  }
}
