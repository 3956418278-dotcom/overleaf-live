/**
 * Core bidirectional synchronization, local mirror watcher, single-step Undo,
 * delete guardrails, SyncTeX coordination, and Overleaf Cloud Compile scheduler.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import {
  cancelLoginPopup,
  clearBrowserAuthProfile,
  CookieJar,
  isLoginPopupActive,
  launchBrowserLoginPopup,
  normalizeBaseUrl,
  parseCookieInput,
} from './auth.mjs';
import { parseLatexLog } from './log_parser.mjs';
import { computeLineDiff, normalizeNewlines } from './ot_diff.mjs';
import { AuthError, OverleafHttp, OverleafRealtimeSession } from './overleaf_client.mjs';
import { getDefaultMirrorRoot, loadConfig, saveConfig } from './state_store.mjs';
import { forwardSync, inverseSync, parseSynctexGz } from './synctex_parser.mjs';

const TEXT_EXTENSIONS = new Set([
  '.tex', '.bib', '.cls', '.sty', '.txt', '.md', '.bst', '.def', '.cfg',
  '.tikz', '.pgf', '.csv', '.json', '.yaml', '.yml', '.ltx', '.dtx', '.ins',
  '.clo', '.fd', '.ldf', '.bbx', '.cbx', '.lbx', '.ist', '.xmpdata',
]);

const IGNORED_EXTENSIONS = new Set([
  '.aux', '.log', '.out', '.toc', '.bbl', '.blg', '.bcf', '.run.xml',
  '.fdb_latexmk', '.fls', '.synctex', '.gz', '.nav', '.snm', '.vrb',
  '.idx', '.ind', '.ilg', '.lof', '.lot', '.xdv', '.dvi', '.swp', '.swo',
  '.tmp', '.bak', '.crdownload',
]);

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.eps': 'application/postscript',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.tex': 'text/plain',
  '.bib': 'text/plain',
};

const UNDO_BATCH_WINDOW_MS = 2000;
const WATCHER_DEBOUNCE_MS = 160;
const ECHO_SUPPRESS_MS = 1000;
const DELETE_BURST_WINDOW_MS = 2000;
const BACKOFF_RETRY_MS = 4500;

function sha256(bufOrStr) {
  return createHash('sha256').update(bufOrStr).digest('hex');
}

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function slugifyProjectName(name) {
  const cleaned = String(name || 'project')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return cleaned || 'project';
}

export function extractProjectId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/\/project\/([a-f0-9]{16,32})/i);
  if (m) return m[1];
  return s;
}

function isTextFilePath(relPath) {
  const ext = extname(relPath).toLowerCase();
  if (!ext) return false;
  return TEXT_EXTENSIONS.has(ext);
}

function shouldIgnoreRelPath(relPath, rootDocPath = '') {
  const posix = toPosix(relPath);
  if (!posix || posix.startsWith('..')) return true;
  const parts = posix.split('/');
  for (const part of parts) {
    if (!part) continue;
    if (part === '.git' || part === 'node_modules' || part === '__pycache__') return true;
    if (part.startsWith('.overleaf-live')) return true;
    if (part === '.DS_Store' || part === 'Thumbs.db' || part === 'desktop.ini') return true;
    if (part.endsWith('~') || part.startsWith('.#')) return true;
  }
  const lower = posix.toLowerCase();
  if (lower === 'output.pdf' || lower === 'output.log' || lower === 'output.synctex.gz') return true;
  if (lower.endsWith('.synctex.gz') || lower.endsWith('.run.xml')) return true;
  if (rootDocPath) {
    const stem = rootDocPath.replace(/\.[^.]+$/i, '').toLowerCase();
    if (lower === `${stem}.pdf`) return true;
  }
  const ext = extname(lower);
  if (IGNORED_EXTENSIONS.has(ext)) return true;
  return false;
}

function detectMimeType(filePath) {
  const ext = extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function buildTreeIndex(project) {
  const rootFolders = Array.isArray(project?.rootFolder) ? project.rootFolder : [];
  const rootFolder = rootFolders[0] || { _id: '', name: 'rootFolder', folders: [], docs: [], fileRefs: [] };
  const rootFolderId = String(rootFolder._id || '');
  const rootDocId = String(project?.rootDoc_id || '');

  const nodesByPath = new Map();
  const nodesById = new Map();
  const folderIdByPath = new Map();
  folderIdByPath.set('', rootFolderId);

  let rootDocPath = '';

  const walk = (folder, prefix) => {
    const folderId = String(folder._id || '');
    const children = [];

    const subFolders = Array.isArray(folder.folders) ? [...folder.folders] : [];
    subFolders.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    for (const sub of subFolders) {
      const name = String(sub.name || '');
      if (!name) continue;
      const relPath = prefix ? `${prefix}/${name}` : name;
      const subId = String(sub._id || '');
      const node = { kind: 'folder', id: subId, name, path: relPath, parentFolderId: folderId };
      nodesByPath.set(relPath, node);
      nodesById.set(subId, node);
      folderIdByPath.set(relPath, subId);
      children.push({ ...node, children: walk(sub, relPath) });
    }

    const docs = Array.isArray(folder.docs) ? [...folder.docs] : [];
    const fileRefs = Array.isArray(folder.fileRefs) ? [...folder.fileRefs] : [];
    const entries = [
      ...docs.map((d) => ({ kind: 'doc', raw: d })),
      ...fileRefs.map((f) => ({ kind: 'file', raw: f })),
    ].sort((a, b) => String(a.raw.name || '').localeCompare(String(b.raw.name || '')));

    for (const item of entries) {
      const name = String(item.raw.name || '');
      if (!name) continue;
      const relPath = prefix ? `${prefix}/${name}` : name;
      const id = String(item.raw._id || '');
      const isRootDoc = item.kind === 'doc' && id === rootDocId;
      if (isRootDoc) rootDocPath = relPath;
      const node = {
        kind: item.kind,
        id,
        name,
        path: relPath,
        parentFolderId: folderId,
        isRootDoc,
      };
      nodesByPath.set(relPath, node);
      nodesById.set(id, node);
      const existingIdx = children.findIndex((c) => c.path === relPath);
      if (existingIdx >= 0) {
        children[existingIdx] = node;
      } else {
        children.push(node);
      }
    }

    return children;
  };

  const tree = walk(rootFolder, '');
  return { rootFolderId, rootDocId, rootDocPath, tree, nodesByPath, nodesById, folderIdByPath };
}

function findFolderObjById(folder, targetId) {
  if (!folder) return null;
  if (String(folder._id) === String(targetId)) return folder;
  for (const sub of folder.folders || []) {
    const found = findFolderObjById(sub, targetId);
    if (found) return found;
  }
  return null;
}

function removeEntityFromProjectObj(folder, entityId) {
  if (!folder) return false;
  for (const key of ['docs', 'fileRefs', 'folders']) {
    const arr = folder[key];
    if (!Array.isArray(arr)) continue;
    const idx = arr.findIndex((item) => String(item._id) === String(entityId));
    if (idx >= 0) {
      arr.splice(idx, 1);
      return true;
    }
  }
  for (const sub of folder.folders || []) {
    if (removeEntityFromProjectObj(sub, entityId)) return true;
  }
  return false;
}

function renameEntityInProjectObj(folder, entityId, newName) {
  if (!folder) return false;
  for (const key of ['docs', 'fileRefs', 'folders']) {
    for (const item of folder[key] || []) {
      if (String(item._id) === String(entityId)) {
        item.name = newName;
        return true;
      }
    }
  }
  for (const sub of folder.folders || []) {
    if (renameEntityInProjectObj(sub, entityId, newName)) return true;
  }
  return false;
}

async function runPool(items, concurrency, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) await worker(next);
    }
  });
  await Promise.all(workers);
}

export class SyncManager {
  #jar;
  #http;
  #config;
  #runtimes = new Map(); // projectId -> runtime
  #projectsCache = [];
  #revision = 1;
  #onChangeListeners = new Set();
  #autoReconnecting = new Set();
  #autoReconnectAttempted = new Set();
  #connectingPromises = new Map();
  #inFlightRuntimes = new Set();

  constructor() {
    this.#jar = new CookieJar();
    if (this.#jar.hasSessionCookie() && !this.#jar.isAuthenticated()) {
      this.#jar.clear();
    }
    this.#http = new OverleafHttp(this.#jar);
    this.#config = loadConfig();
  }

  get revision() {
    return this.#revision;
  }

  #bumpRevision() {
    this.#revision += 1;
    for (const fn of this.#onChangeListeners) {
      try { fn(this.#revision); } catch {}
    }
  }

  onChange(listener) {
    this.#onChangeListeners.add(listener);
    return () => this.#onChangeListeners.delete(listener);
  }

  getAuthStatus() {
    return {
      authenticated: this.#jar.isAuthenticated(),
      userEmail: this.#jar.userEmail || '',
      baseUrl: this.#jar.baseUrl,
      loginPopupActive: isLoginPopupActive(),
      updatedAt: this.#jar.updatedAt || 0,
    };
  }

  async setCookieAuth({ cookieInput, baseUrl } = {}) {
    const targetBase = baseUrl ? normalizeBaseUrl(baseUrl) : this.#jar.baseUrl;
    const cookies = parseCookieInput(cookieInput);
    const tempJar = new CookieJar({ baseUrl: targetBase, cookies, ephemeral: true });
    const tempHttp = new OverleafHttp(tempJar);
    const info = await tempHttp.verifyAndListProjects();

    this.#jar.baseUrl = targetBase;
    this.#jar.setCookies(tempJar.toObject(), { replace: true, persist: false });
    this.#jar.csrfToken = tempJar.csrfToken;
    this.#jar.userEmail = tempJar.userEmail;
    this.#jar.verified = true;
    this.#jar.persist();
    this.#autoReconnectAttempted.clear();

    this.#projectsCache = info.projects;
    this.#bumpRevision();
    return {
      ...this.getAuthStatus(),
      projects: this.#projectsCache,
    };
  }

  async startPopupAuth({ baseUrl, headless = false } = {}) {
    const targetBase = normalizeBaseUrl(baseUrl || this.#jar.baseUrl);
    this.#jar.baseUrl = targetBase;
    if (this.#jar.isAuthenticated()) {
      this.#jar.persist();
    }

    const res = await launchBrowserLoginPopup({
      baseUrl: targetBase,
      headless: Boolean(headless),
      verifySession: async (cookieMap) => {
        const tempJar = new CookieJar({ baseUrl: targetBase, cookies: cookieMap, ephemeral: true });
        const tempHttp = new OverleafHttp(tempJar);
        const info = await tempHttp.verifyAndListProjects();
        this.#jar.baseUrl = targetBase;
        this.#jar.setCookies(tempJar.toObject(), { replace: true, persist: false });
        this.#jar.csrfToken = tempJar.csrfToken;
        this.#jar.userEmail = tempJar.userEmail;
        this.#jar.verified = true;
        this.#jar.persist();
        this.#autoReconnectAttempted.clear();
        this.#projectsCache = info.projects;
        return info;
      },
      onSuccess: async () => {
        this.#bumpRevision();
      },
      onError: () => {
        this.#bumpRevision();
      },
      onClose: () => {
        this.#bumpRevision();
      },
    });
    this.#bumpRevision();
    return res;
  }

  cancelPopupAuth() {
    const cancelled = cancelLoginPopup();
    this.#bumpRevision();
    return { cancelled };
  }

  logout() {
    cancelLoginPopup();
    clearBrowserAuthProfile();
    for (const runtime of this.#inFlightRuntimes) {
      this.#disposeRuntime(runtime);
    }
    this.#inFlightRuntimes.clear();
    for (const runtime of this.#runtimes.values()) {
      this.#disposeRuntime(runtime);
    }
    this.#runtimes.clear();
    this.#autoReconnecting.clear();
    this.#autoReconnectAttempted.clear();
    this.#projectsCache = [];
    this.#jar.clear();
    this.#bumpRevision();
    return { loggedOut: true };
  }

  async listProjects({ refresh = false, query = '' } = {}) {
    if (!this.#jar.isAuthenticated()) {
      throw new AuthError();
    }
    if (refresh || this.#projectsCache.length === 0) {
      try {
        const info = await this.#http.verifyAndListProjects();
        this.#projectsCache = info.projects;
        this.#bumpRevision();
      } catch (err) {
        if (err instanceof AuthError) {
          this.#jar.clear();
          this.#projectsCache = [];
          this.#bumpRevision();
        }
        throw err;
      }
    }
    const q = String(query || '').trim().toLowerCase();
    if (!q) return this.#projectsCache;
    return this.#projectsCache.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    );
  }

  resolveProjectId({ projectId = '', conversationId = '' } = {}) {
    const explicit = extractProjectId(projectId);
    if (explicit) return explicit;
    if (conversationId && this.#config.bindings[conversationId]) {
      return this.#config.bindings[conversationId];
    }
    if (this.#runtimes.size === 1) {
      return this.#runtimes.keys().next().value;
    }
    const configuredIds = Object.keys(this.#config.projects || {});
    if (configuredIds.length === 1) return configuredIds[0];
    return '';
  }

  bindConversation(conversationId, projectId) {
    if (!conversationId || !projectId) return;
    if (this.#config.bindings[conversationId] !== projectId) {
      this.#config.bindings[conversationId] = projectId;
      saveConfig(this.#config);
      this.#bumpRevision();
    }
  }

  async ensureRuntime(projectId, { conversationId = '' } = {}) {
    const id = extractProjectId(projectId || this.resolveProjectId({ conversationId }));
    if (!id) throw new Error('尚未连接或绑定任何 Overleaf 项目。');
    const existing = this.#runtimes.get(id);
    if (existing) {
      if (conversationId) this.bindConversation(conversationId, id);
      return existing;
    }
    const cfgProj = this.#config.projects[id];
    return this.connectProject({
      projectId: id,
      conversationId,
      mirrorDir: cfgProj?.mirrorDir || '',
      autoInitialCompile: false,
    });
  }

  async connectProject({
    projectId,
    conversationId = '',
    mirrorDir = '',
    autoInitialCompile = true,
  } = {}) {
    const id = extractProjectId(projectId);
    if (!id) throw new Error('请提供有效的 Overleaf 项目 ID 或链接。');
    if (!this.#jar.isAuthenticated()) throw new AuthError();

    let runtime = this.#runtimes.get(id);
    if (runtime) {
      if (mirrorDir && resolve(mirrorDir) !== runtime.mirrorDir) {
        this.#disposeRuntime(runtime);
        this.#runtimes.delete(id);
        runtime = null;
      } else {
        if (conversationId) this.bindConversation(conversationId, id);
        return runtime;
      }
    }

    const existingConnect = this.#connectingPromises.get(id);
    if (existingConnect) {
      const joined = await existingConnect;
      if (conversationId) this.bindConversation(conversationId, id);
      return joined;
    }

    const doConnect = async () => {
      const cachedMeta = this.#projectsCache.find((p) => p.id === id);
      const savedCfg = this.#config.projects[id] || {};
      const realtime = new OverleafRealtimeSession({ http: this.#http, projectId: id });
      const project = await realtime.connect();

      const projectName = String(project?.name || cachedMeta?.name || savedCfg.name || id);
      const resolvedMirror = mirrorDir
        ? resolve(mirrorDir)
        : savedCfg.mirrorDir
          ? resolve(savedCfg.mirrorDir)
          : join(getDefaultMirrorRoot(), `${slugifyProjectName(projectName)}-${id.slice(-6)}`);

      mkdirSync(resolvedMirror, { recursive: true });

      runtime = {
        projectId: id,
        projectName,
        mirrorDir: resolvedMirror,
        autoCompile: savedCfg.autoCompile !== undefined ? Boolean(savedCfg.autoCompile) : true,
        debounceMs: Number(savedCfg.debounceMs) || 2500,
        realtime,
        project,
        treeIndex: buildTreeIndex(project),
        rootDocId: String(project?.rootDoc_id || ''),
        rootDocPath: '',
        compileTargetDocId: String(savedCfg.compileTargetDocId || ''),
        compileTargetPath: String(savedCfg.compileTargetPath || ''),
        fileBuffers: new Map(), // binary file cache for delete guardrail / undo
        diskHashes: new Map(), // relPath -> sha256
        fileIndex: { ...(savedCfg.fileIndex || {}) }, // persisted { id, sha256 } cache
        echoIgnoreUntil: new Map(), // relPath -> ts
        lastModifiedBy: new Map(), // relPath -> 'agent' | 'panel' | 'remote'
        lastUndoBatch: null,
        guardrailAlert: null,
        watcher: null,
        watcherTimers: new Map(),
        recentDeletes: [],
        compileDebounceTimer: null,
        backoffTimer: null,
        compiling: false,
        compileDirty: false,
        activeCompilePromise: null,
        queuedCompilePromise: null,
        pullingPromise: null,
        disposed: false,
        pdfBuffer: null,
        pdfEtag: '',
        synctexIndex: null,
        compileResult: null,
        focusSeq: 0,
        focusState: null,
        lastError: '',
        pendingEditPromises: new Set(),
      };

      runtime.rootDocPath = runtime.treeIndex.rootDocPath;
      this.#inFlightRuntimes.add(runtime);

      try {
        this.#wireRealtimeEvents(runtime);
        await this.#pullInitialMirror(runtime);
        if (runtime.disposed) {
          throw new Error('项目连接已关闭');
        }

        this.#runtimes.set(id, runtime);
        if (conversationId) {
          this.#config.bindings[conversationId] = id;
        }
        this.#saveProjectConfig(runtime);
        this.#startWatcher(runtime);
      } catch (err) {
        this.#disposeRuntime(runtime);
        throw err;
      } finally {
        this.#inFlightRuntimes.delete(runtime);
      }

      // Pick sensible default focused file (root .tex or first .tex)
      if (!runtime.focusState) {
        const initialPath =
          runtime.rootDocPath ||
          [...runtime.treeIndex.nodesByPath.values()].find((n) => n.kind === 'doc')?.path ||
          '';
        if (initialPath) {
          runtime.focusSeq += 1;
          runtime.focusState = {
            seq: runtime.focusSeq,
            file: initialPath,
            line: 1,
            highlight: null,
            updatedAt: Date.now(),
            updatedBy: 'system',
          };
        }
      }

      this.#bumpRevision();

      if (autoInitialCompile && !runtime.pdfBuffer) {
        this.runCloudCompile(id, { reason: 'initial' }).catch((err) => {
          runtime.lastError = err.message;
          this.#bumpRevision();
        });
      }

      return runtime;
    };

    const connectPromise = doConnect();
    this.#connectingPromises.set(id, connectPromise);
    try {
      return await connectPromise;
    } finally {
      if (this.#connectingPromises.get(id) === connectPromise) {
        this.#connectingPromises.delete(id);
      }
    }
  }

  #disposeRuntime(runtime) {
    runtime.disposed = true;
    clearTimeout(runtime.compileDebounceTimer);
    clearTimeout(runtime.backoffTimer);
    for (const t of runtime.watcherTimers.values()) clearTimeout(t);
    runtime.watcherTimers.clear();
    try { runtime.watcher?.close(); } catch {}
    runtime.watcher = null;
    try { runtime.realtime.close(); } catch {}
  }

  closeAll() {
    cancelLoginPopup();
    for (const runtime of this.#inFlightRuntimes) {
      this.#disposeRuntime(runtime);
    }
    this.#inFlightRuntimes.clear();
    for (const runtime of this.#runtimes.values()) {
      this.#disposeRuntime(runtime);
    }
    this.#runtimes.clear();
  }

  #saveProjectConfig(runtime) {
    this.#config.projects[runtime.projectId] = {
      id: runtime.projectId,
      name: runtime.projectName,
      mirrorDir: runtime.mirrorDir,
      autoCompile: runtime.autoCompile,
      debounceMs: runtime.debounceMs,
      compileTargetDocId: runtime.compileTargetDocId || '',
      compileTargetPath: runtime.compileTargetPath || '',
      fileIndex: { ...(runtime.fileIndex || {}) },
    };
    saveConfig(this.#config);
  }

  #refreshTreeIndex(runtime) {
    runtime.treeIndex = buildTreeIndex(runtime.project);
    runtime.rootDocId = String(runtime.project?.rootDoc_id || runtime.rootDocId || '');
    runtime.rootDocPath = runtime.treeIndex.rootDocPath;
  }

  #wireRealtimeEvents(runtime) {
    const rt = runtime.realtime;

    rt.on('status', () => {
      this.#bumpRevision();
    });

    rt.on('error', (err) => {
      runtime.lastError = err?.message || String(err);
      this.#bumpRevision();
    });

    rt.on('joined', async ({ project }) => {
      if (project) {
        runtime.project = project;
        this.#refreshTreeIndex(runtime);
        this.#bumpRevision();
      }
    });

    rt.on('reconnected', async () => {
      runtime.lastError = '';
      await this.#pullInitialMirror(runtime);
      this.#bumpRevision();
    });

    rt.on('docUpdate', ({ docId, text }) => {
      const node = runtime.treeIndex.nodesById.get(docId);
      if (!node) return;
      const absPath = join(runtime.mirrorDir, ...node.path.split('/'));
      this.#writeMirrorText(runtime, node.path, absPath, text);
      runtime.lastModifiedBy.set(node.path, 'remote');
      this.#scheduleAutoCompile(runtime);
      this.#bumpRevision();
    });

    rt.on('entityCreated', async ({ kind, parentFolderId, entity }) => {
      if (!entity || !entity._id) return;
      const folder = findFolderObjById(runtime.project?.rootFolder?.[0], parentFolderId);
      if (folder) {
        const key = kind === 'doc' ? 'docs' : kind === 'file' ? 'fileRefs' : 'folders';
        folder[key] = folder[key] || [];
        if (!folder[key].some((x) => String(x._id) === String(entity._id))) {
          folder[key].push(entity);
        }
        this.#refreshTreeIndex(runtime);
        const node = runtime.treeIndex.nodesById.get(String(entity._id));
        if (node) {
          const absPath = join(runtime.mirrorDir, ...node.path.split('/'));
          if (kind === 'folder') {
            mkdirSync(absPath, { recursive: true });
          } else if (kind === 'doc') {
            const doc = await rt.joinDoc(node.id);
            this.#writeMirrorText(runtime, node.path, absPath, doc.text);
          } else if (kind === 'file') {
            const buf = await this.#http.downloadFile(runtime.projectId, node.id);
            this.#writeMirrorBinary(runtime, node.path, absPath, buf);
          }
        }
        this.#bumpRevision();
      }
    });

    rt.on('entityRenamed', ({ entityId, newName }) => {
      const prevNode = runtime.treeIndex.nodesById.get(String(entityId));
      const oldRel = prevNode?.path;
      if (renameEntityInProjectObj(runtime.project?.rootFolder?.[0], entityId, newName)) {
        this.#refreshTreeIndex(runtime);
        const nextNode = runtime.treeIndex.nodesById.get(String(entityId));
        if (oldRel && nextNode && oldRel !== nextNode.path) {
          const oldAbs = join(runtime.mirrorDir, ...oldRel.split('/'));
          const newAbs = join(runtime.mirrorDir, ...nextNode.path.split('/'));
          runtime.echoIgnoreUntil.set(oldRel, Date.now() + ECHO_SUPPRESS_MS);
          runtime.echoIgnoreUntil.set(nextNode.path, Date.now() + ECHO_SUPPRESS_MS);
          try {
            if (existsSync(oldAbs)) {
              mkdirSync(dirname(newAbs), { recursive: true });
              const data = readFileSync(oldAbs);
              writeFileSync(newAbs, data);
              rmSync(oldAbs, { recursive: true, force: true });
              runtime.diskHashes.set(nextNode.path, sha256(data));
              runtime.diskHashes.delete(oldRel);
            }
          } catch {}
        }
        this.#bumpRevision();
      }
    });

    rt.on('entityDeleted', ({ entityId }) => {
      const node = runtime.treeIndex.nodesById.get(String(entityId));
      if (removeEntityFromProjectObj(runtime.project?.rootFolder?.[0], entityId)) {
        this.#refreshTreeIndex(runtime);
        if (node) {
          const abs = join(runtime.mirrorDir, ...node.path.split('/'));
          runtime.echoIgnoreUntil.set(node.path, Date.now() + ECHO_SUPPRESS_MS);
          runtime.diskHashes.delete(node.path);
          runtime.fileBuffers.delete(node.path);
          try { rmSync(abs, { recursive: true, force: true }); } catch {}
        }
        this.#bumpRevision();
      }
    });

    rt.on('entityMoved', () => {
      // Refresh project tree safely on next pull or prompt reconnect if needed
      this.#bumpRevision();
    });
  }

  #isDiskHashSynced(runtime, relPath, absPath, hash) {
    if (!existsSync(absPath)) return false;
    if (runtime.diskHashes.get(relPath) === hash) return true;
    try {
      if (sha256(readFileSync(absPath)) === hash) {
        runtime.diskHashes.set(relPath, hash);
        return true;
      }
    } catch {
      // Ignore transient read error and rewrite mirror file
    }
    return false;
  }

  #writeMirrorText(runtime, relPath, absPath, text) {
    const normalized = normalizeNewlines(text);
    const buf = Buffer.from(normalized, 'utf8');
    const hash = sha256(buf);
    if (this.#isDiskHashSynced(runtime, relPath, absPath, hash)) {
      return;
    }
    mkdirSync(dirname(absPath), { recursive: true });
    runtime.echoIgnoreUntil.set(relPath, Date.now() + ECHO_SUPPRESS_MS);
    runtime.diskHashes.set(relPath, hash);
    writeFileSync(absPath, buf);
  }

  #writeMirrorBinary(runtime, relPath, absPath, buf) {
    const hash = sha256(buf);
    runtime.fileBuffers.set(relPath, buf);
    if (this.#isDiskHashSynced(runtime, relPath, absPath, hash)) {
      return;
    }
    mkdirSync(dirname(absPath), { recursive: true });
    runtime.echoIgnoreUntil.set(relPath, Date.now() + ECHO_SUPPRESS_MS);
    runtime.diskHashes.set(relPath, hash);
    writeFileSync(absPath, buf);
  }

  #pullInitialMirror(runtime) {
    if (runtime.pullingPromise) {
      return runtime.pullingPromise;
    }

    const pullPromise = (async () => {
      const nodes = [...runtime.treeIndex.nodesByPath.values()];

      for (const n of nodes) {
        if (runtime.disposed) return;
        if (n.kind === 'folder') {
          mkdirSync(join(runtime.mirrorDir, ...n.path.split('/')), { recursive: true });
        }
      }

      const docs = nodes.filter((n) => n.kind === 'doc');
      await runPool(docs, 6, async (node) => {
        if (runtime.disposed) return;
        const doc = await runtime.realtime.joinDoc(node.id);
        if (runtime.disposed) return;
        const absPath = join(runtime.mirrorDir, ...node.path.split('/'));
        this.#writeMirrorText(runtime, node.path, absPath, doc.text);
      });

      const files = nodes.filter((n) => n.kind === 'file');
      runtime.fileIndex = runtime.fileIndex || {};
      await runPool(files, 2, async (node) => {
        if (runtime.disposed) return;
        const absPath = join(runtime.mirrorDir, ...node.path.split('/'));
        const cachedMeta = runtime.fileIndex[node.path];
        if (cachedMeta && cachedMeta.id === node.id && cachedMeta.sha256 && existsSync(absPath)) {
          try {
            const localBuf = readFileSync(absPath);
            const localHash = sha256(localBuf);
            if (localHash === cachedMeta.sha256) {
              runtime.fileBuffers.set(node.path, localBuf);
              runtime.diskHashes.set(node.path, localHash);
              return;
            }
          } catch {
            // Fall back to remote download when local cache read fails
          }
        }

        try {
          const buf = await this.#http.downloadFile(runtime.projectId, node.id);
          if (runtime.disposed) return;
          this.#writeMirrorBinary(runtime, node.path, absPath, buf);
          runtime.fileIndex[node.path] = {
            id: node.id,
            sha256: runtime.diskHashes.get(node.path),
          };
        } catch (err) {
          if (existsSync(absPath)) {
            try {
              const cachedBuf = readFileSync(absPath);
              runtime.fileBuffers.set(node.path, cachedBuf);
              runtime.diskHashes.set(node.path, sha256(cachedBuf));
              return;
            } catch {
              // Fall through to report error if local cache read fails
            }
          }
          runtime.diskHashes.set(node.path, '');
          runtime.lastError = `下载附件 ${node.path} 失败: ${err.message}`;
        }
      });

      if (runtime.disposed) return;
      for (const k of Object.keys(runtime.fileIndex)) {
        if (runtime.treeIndex.nodesByPath.get(k)?.kind !== 'file') {
          delete runtime.fileIndex[k];
        }
      }
      if (this.#runtimes.has(runtime.projectId)) {
        this.#saveProjectConfig(runtime);
      }
    })();

    runtime.pullingPromise = pullPromise;
    return pullPromise.finally(() => {
      if (runtime.pullingPromise === pullPromise) {
        runtime.pullingPromise = null;
      }
    });
  }

  #recordUndoSnapshot(runtime, relPath, source, description) {
    const now = Date.now();
    let batch = runtime.lastUndoBatch;
    if (!batch || now - batch.timestamp > UNDO_BATCH_WINDOW_MS || batch.source !== source) {
      batch = {
        id: randomUUID().slice(0, 8),
        timestamp: now,
        source,
        description,
        files: new Map(),
      };
      runtime.lastUndoBatch = batch;
    } else {
      batch.timestamp = now;
    }

    if (batch.files.has(relPath)) return;

    const node = runtime.treeIndex.nodesByPath.get(relPath);
    if (!node) {
      batch.files.set(relPath, { existed: false, kind: isTextFilePath(relPath) ? 'doc' : 'file' });
      return;
    }

    if (node.kind === 'doc') {
      const doc = runtime.realtime.getDocState(node.id);
      batch.files.set(relPath, {
        existed: true,
        kind: 'doc',
        prevContent: doc?.text ?? '',
      });
    } else if (node.kind === 'file') {
      const prevBuf = runtime.fileBuffers.get(relPath) || null;
      batch.files.set(relPath, {
        existed: true,
        kind: 'file',
        prevBuffer: prevBuf ? Buffer.from(prevBuf) : null,
      });
    }
  }

  #startWatcher(runtime) {
    try {
      runtime.watcher = watch(runtime.mirrorDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const relPath = toPosix(filename);
        if (!runtime.treeIndex.nodesByPath.has(relPath) && shouldIgnoreRelPath(relPath, runtime.rootDocPath)) return;

        const existingTimer = runtime.watcherTimers.get(relPath);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(() => {
          runtime.watcherTimers.delete(relPath);
          const task = this.#processWatcherPath(runtime, relPath).catch((err) => {
            runtime.lastError = err.message;
            this.#bumpRevision();
          });
          runtime.pendingEditPromises.add(task);
          task.finally(() => runtime.pendingEditPromises.delete(task));
        }, WATCHER_DEBOUNCE_MS);
        runtime.watcherTimers.set(relPath, timer);
      });
    } catch (err) {
      runtime.lastError = `本地文件监听启动失败: ${err.message}`;
    }
  }

  async #processWatcherPath(runtime, relPath) {
    const absPath = join(runtime.mirrorDir, ...relPath.split('/'));
    const suppressUntil = runtime.echoIgnoreUntil.get(relPath) || 0;

    const exists = existsSync(absPath);
    if (exists) {
      let st;
      try {
        st = statSync(absPath);
      } catch {
        return;
      }
      if (st.isDirectory()) return;

      const rawBuf = readFileSync(absPath);
      const rawHash = sha256(rawBuf);
      // Compare against our last mirror hash rather than blocking a fixed time window,
      // so immediate agent edits after `connectProject` or remote updates are never lost.
      if (runtime.diskHashes.get(relPath) === rawHash) return;

      const existingNode = runtime.treeIndex.nodesByPath.get(relPath);
      if (existingNode?.kind === 'doc' || (!existingNode && isTextFilePath(relPath))) {
        const normalized = normalizeNewlines(rawBuf.toString('utf8'));
        const normHash = sha256(Buffer.from(normalized, 'utf8'));
        runtime.diskHashes.set(relPath, rawHash);

        if (existingNode) {
          const doc = await runtime.realtime.joinDoc(existingNode.id);
          if (doc.text === normalized) {
            return;
          }
          const changedLine = findFirstChangedLine(doc.text, normalized);
          this.#recordUndoSnapshot(runtime, relPath, 'agent', `修改 ${relPath}`);
          await runtime.realtime.sendDocEdit(existingNode.id, normalized);
          runtime.lastModifiedBy.set(relPath, 'agent');
          this.#updateFocusState(runtime, relPath, changedLine, 'agent');
        } else {
          this.#recordUndoSnapshot(runtime, relPath, 'agent', `新建 ${relPath}`);
          const parentDir = dirname(relPath) === '.' ? '' : toPosix(dirname(relPath));
          const parentFolderId = await this.#ensureRemoteFolderPath(runtime, parentDir);
          const created = await this.#http.createDoc(runtime.projectId, parentFolderId, basename(relPath));
          const docId = String(created?._id || created?.id || '');
          if (docId) {
            this.#insertLocalTreeNode(runtime, parentFolderId, 'doc', { _id: docId, name: basename(relPath) });
            await runtime.realtime.joinDoc(docId);
            await runtime.realtime.sendDocEdit(docId, normalized);
            runtime.lastModifiedBy.set(relPath, 'agent');
            this.#updateFocusState(runtime, relPath, 1, 'agent');
          }
        }
        this.#scheduleAutoCompile(runtime);
        this.#bumpRevision();
        return;
      }

      // Binary file update or upload
      this.#recordUndoSnapshot(runtime, relPath, 'agent', `上传 ${relPath}`);
      runtime.diskHashes.set(relPath, rawHash);
      runtime.fileBuffers.set(relPath, rawBuf);
      const parentDir = dirname(relPath) === '.' ? '' : toPosix(dirname(relPath));
      const parentFolderId = existingNode?.parentFolderId || (await this.#ensureRemoteFolderPath(runtime, parentDir));
      const uploaded = await this.#http.uploadFile(
        runtime.projectId,
        parentFolderId,
        basename(relPath),
        rawBuf,
        detectMimeType(relPath)
      );
      const fileId = String(uploaded?.entity_id || uploaded?._id || existingNode?.id || '');
      if (fileId) {
        this.#insertLocalTreeNode(runtime, parentFolderId, 'file', { _id: fileId, name: basename(relPath) });
        runtime.fileIndex = runtime.fileIndex || {};
        runtime.fileIndex[relPath] = { id: fileId, sha256: rawHash };
        this.#saveProjectConfig(runtime);
      }
      runtime.lastModifiedBy.set(relPath, 'agent');
      this.#scheduleAutoCompile(runtime);
      this.#bumpRevision();
      return;
    }

    // File deleted locally on disk (honor echo suppression from our own unlinks/renames)
    if (Date.now() < suppressUntil) {
      return;
    }
    const existingNode = runtime.treeIndex.nodesByPath.get(relPath);
    if (!existingNode || existingNode.kind === 'folder') return;

    const now = Date.now();
    runtime.recentDeletes = runtime.recentDeletes.filter((ts) => now - ts <= DELETE_BURST_WINDOW_MS);
    runtime.recentDeletes.push(now);

    const isRoot =
      existingNode.id === runtime.rootDocId ||
      (runtime.rootDocPath && relPath === runtime.rootDocPath);
    const isBulkDelete = runtime.recentDeletes.length > 1;

    if (isRoot || isBulkDelete) {
      // Destructive delete guardrail: restore file back to disk and warn!
      await this.#restoreNodeToDisk(runtime, existingNode);
      runtime.guardrailAlert = {
        id: randomUUID().slice(0, 8),
        timestamp: Date.now(),
        message: isRoot
          ? `已拦截误删主文档 ${relPath} 并自动恢复。若确需删除，请通过面板或确认参数执行。`
          : `检测到短时批量删除文件（含 ${relPath}），已拦截并自动恢复以防误删。`,
      };
      this.#bumpRevision();
      return;
    }

    this.#recordUndoSnapshot(runtime, relPath, 'agent', `删除 ${relPath}`);
    await this.#http.deleteEntity(runtime.projectId, existingNode.kind, existingNode.id);
    removeEntityFromProjectObj(runtime.project?.rootFolder?.[0], existingNode.id);
    runtime.diskHashes.delete(relPath);
    runtime.fileBuffers.delete(relPath);
    if (runtime.fileIndex && Object.hasOwn(runtime.fileIndex, relPath)) {
      delete runtime.fileIndex[relPath];
      this.#saveProjectConfig(runtime);
    }
    this.#refreshTreeIndex(runtime);
    this.#scheduleAutoCompile(runtime);
    this.#bumpRevision();
  }

  async #restoreNodeToDisk(runtime, node) {
    const absPath = join(runtime.mirrorDir, ...node.path.split('/'));
    if (node.kind === 'doc') {
      const doc = await runtime.realtime.joinDoc(node.id);
      this.#writeMirrorText(runtime, node.path, absPath, doc.text);
    } else if (node.kind === 'file') {
      let buf = runtime.fileBuffers.get(node.path);
      if (!buf) {
        buf = await this.#http.downloadFile(runtime.projectId, node.id);
      }
      this.#writeMirrorBinary(runtime, node.path, absPath, buf);
    }
  }

  #insertLocalTreeNode(runtime, parentFolderId, kind, entity) {
    const folder = findFolderObjById(runtime.project?.rootFolder?.[0], parentFolderId);
    if (!folder) return;
    const key = kind === 'doc' ? 'docs' : kind === 'file' ? 'fileRefs' : 'folders';
    folder[key] = folder[key] || [];
    const existingIdx = folder[key].findIndex(
      (x) => String(x._id) === String(entity._id) || String(x.name) === String(entity.name)
    );
    if (existingIdx >= 0) {
      folder[key][existingIdx] = { ...folder[key][existingIdx], ...entity, _id: entity._id };
    } else {
      folder[key].push(entity);
    }
    this.#refreshTreeIndex(runtime);
  }

  async #ensureRemoteFolderPath(runtime, relDir) {
    const clean = toPosix(relDir);
    if (!clean || clean === '.') return runtime.treeIndex.rootFolderId;
    const existing = runtime.treeIndex.folderIdByPath.get(clean);
    if (existing) return existing;

    const parts = clean.split('/').filter(Boolean);
    let currPath = '';
    let parentId = runtime.treeIndex.rootFolderId;
    for (const seg of parts) {
      currPath = currPath ? `${currPath}/${seg}` : seg;
      let nextId = runtime.treeIndex.folderIdByPath.get(currPath);
      if (!nextId) {
        const created = await this.#http.createFolder(runtime.projectId, parentId, seg);
        nextId = String(created?._id || created?.id || '');
        if (!nextId) throw new Error(`创建远端文件夹 ${currPath} 失败`);
        this.#insertLocalTreeNode(runtime, parentId, 'folder', {
          _id: nextId,
          name: seg,
          folders: [],
          docs: [],
          fileRefs: [],
        });
      }
      parentId = nextId;
    }
    return parentId;
  }

  #updateFocusState(runtime, relPath, line, updatedBy = 'agent') {
    const targetLine = Math.max(1, Number(line) || 1);
    const highlight = runtime.synctexIndex
      ? forwardSync(runtime.synctexIndex, relPath, targetLine)
      : null;
    runtime.focusSeq += 1;
    runtime.focusState = {
      seq: runtime.focusSeq,
      file: relPath,
      line: targetLine,
      highlight,
      updatedAt: Date.now(),
      updatedBy,
    };
  }

  #scheduleAutoCompile(runtime) {
    if (!runtime.autoCompile) return;
    clearTimeout(runtime.compileDebounceTimer);
    runtime.compileDebounceTimer = setTimeout(() => {
      this.runCloudCompile(runtime.projectId, { reason: 'auto' }).catch((err) => {
        runtime.lastError = err.message;
        this.#bumpRevision();
      });
    }, runtime.debounceMs || 2500);
  }

  async flushPendingSync(runtime) {
    if (runtime.pullingPromise) {
      await runtime.pullingPromise;
    }

    // 1. Drain any queued watcher debounce timers immediately
    for (const [relPath, timer] of runtime.watcherTimers.entries()) {
      clearTimeout(timer);
      runtime.watcherTimers.delete(relPath);
      const task = this.#processWatcherPath(runtime, relPath);
      runtime.pendingEditPromises.add(task);
      task.finally(() => runtime.pendingEditPromises.delete(task));
    }

    // 2. Proactive hash check across tracked mirror files in case OS fs.watch
    // has not delivered a very recent write event yet.
    for (const node of runtime.treeIndex.nodesByPath.values()) {
      if (node.kind === 'folder') continue;
      if (!runtime.diskHashes.has(node.path)) continue;
      const absPath = join(runtime.mirrorDir, ...node.path.split('/'));
      if (!existsSync(absPath)) continue;
      try {
        const hash = sha256(readFileSync(absPath));
        if (hash !== runtime.diskHashes.get(node.path)) {
          runtime.echoIgnoreUntil.delete(node.path);
          const task = this.#processWatcherPath(runtime, node.path);
          runtime.pendingEditPromises.add(task);
          task.finally(() => runtime.pendingEditPromises.delete(task));
        }
      } catch {
        // Ignore transient lock while another tool writes
      }
    }

    if (runtime.pendingEditPromises.size > 0) {
      await Promise.allSettled([...runtime.pendingEditPromises]);
    }
  }

  async setCompileTarget(projectId, relPath) {
    const runtime = await this.ensureRuntime(projectId);
    const cleanPath = toPosix(relPath);
    const node = runtime.treeIndex.nodesByPath.get(cleanPath);
    if (!node || node.kind !== 'doc') {
      throw new Error(`找不到可编译文档: ${cleanPath}`);
    }
    if (node.id !== runtime.rootDocId) {
      await this.#http.setRootDoc(runtime.projectId, node.id);
      runtime.rootDocId = node.id;
      runtime.rootDocPath = cleanPath;
      if (runtime.project) {
        runtime.project.rootDoc_id = node.id;
      }
      this.#refreshTreeIndex(runtime);
    }
    runtime.compileTargetDocId = node.id;
    runtime.compileTargetPath = cleanPath;
    runtime.forceCleanNextCompile = true;
    this.#saveProjectConfig(runtime);
    this.#bumpRevision();
    return {
      compileTargetDocId: runtime.compileTargetDocId,
      compileTargetPath: runtime.compileTargetPath,
    };
  }

  async runCloudCompile(projectId, { draft = false, reason = 'manual', targetFile = '' } = {}) {
    const runtime = await this.ensureRuntime(projectId);
    let targetDocId = runtime.compileTargetDocId || runtime.rootDocId;
    let switchedRootDoc = Boolean(runtime.forceCleanNextCompile);
    if (targetFile) {
      const cleanTarget = toPosix(targetFile);
      const targetNode = runtime.treeIndex.nodesByPath.get(cleanTarget);
      if (!targetNode || targetNode.kind !== 'doc') {
        throw new Error(`找不到可编译文档: ${cleanTarget}`);
      }
      targetDocId = targetNode.id;
      if (targetDocId !== runtime.rootDocId) {
        await this.#http.setRootDoc(runtime.projectId, targetDocId);
        runtime.rootDocId = targetDocId;
        runtime.rootDocPath = cleanTarget;
        runtime.compileTargetDocId = targetDocId;
        runtime.compileTargetPath = cleanTarget;
        if (runtime.project) {
          runtime.project.rootDoc_id = targetDocId;
        }
        this.#refreshTreeIndex(runtime);
        this.#saveProjectConfig(runtime);
        switchedRootDoc = true;
      }
    }
    clearTimeout(runtime.compileDebounceTimer);
    clearTimeout(runtime.backoffTimer);

    if (runtime.activeCompilePromise) {
      if (!runtime.queuedCompilePromise) {
        runtime.queuedCompilePromise = runtime.activeCompilePromise
          .catch(() => {})
          .then(() => {
            runtime.queuedCompilePromise = null;
            return this.runCloudCompile(runtime.projectId, { draft, reason, targetFile });
          });
      }
      return runtime.queuedCompilePromise;
    }

    const execCompile = async () => {
      runtime.compiling = true;
      runtime.compileDirty = false;
      this.#bumpRevision();
      const startedAt = Date.now();

      try {
        await this.flushPendingSync(runtime);
        clearTimeout(runtime.compileDebounceTimer);
        runtime.forceCleanNextCompile = false;
        const res = await this.#http.compile(runtime.projectId, targetDocId, {
          draft,
          incremental: !switchedRootDoc,
        });
        const status = String(res?.status || 'unknown');

        if (status === 'too-recently-compiled' || status === 'autocompile-backoff') {
          runtime.compileResult = {
            ...(runtime.compileResult || {}),
            status: 'backoff',
            rawStatus: status,
            reason,
            durationMs: Date.now() - startedAt,
            compiledAt: Date.now(),
          };
          clearTimeout(runtime.backoffTimer);
          runtime.backoffTimer = setTimeout(() => {
            this.runCloudCompile(runtime.projectId, { draft, reason: 'backoff-retry' }).catch(() => {});
          }, BACKOFF_RETRY_MS);
          return runtime.compileResult;
        }

        const clsiServerId = String(res?.clsiServerId || '');
        const outputFiles = Array.isArray(res?.outputFiles) ? res.outputFiles : [];
        const findOut = (exactPath, typeName, fallbackRegex) =>
          outputFiles.find((f) => String(f.path || '') === exactPath) ||
          (typeName ? outputFiles.find((f) => f.type === typeName) : null) ||
          outputFiles.find((f) => fallbackRegex.test(String(f.path || f.url || '')));

        const pdfEntry = findOut('output.pdf', 'pdf', /\.pdf(?:$|\?)/i);
        const logEntry = findOut('output.log', 'log', /\.log(?:$|\?)/i);
        const synctexEntry = findOut('output.synctex.gz', 'synctex', /\.synctex(?:\.gz)?(?:$|\?)/i);
        const stderrEntry = findOut('output.stderr', 'stderr', /\.stderr(?:$|\?)/i);

        let logText = '';
        if (logEntry?.url) {
          try {
            const logBuf = await this.#http.downloadBuildArtifact(logEntry.url, { clsiServerId });
            logText = logBuf.toString('utf8');
          } catch {}
        }

        if (pdfEntry?.url) {
          try {
            const pdfBuf = await this.#http.downloadBuildArtifact(pdfEntry.url, { clsiServerId });
            runtime.pdfBuffer = pdfBuf;
            runtime.pdfEtag = createHash('sha1').update(pdfBuf).digest('hex').slice(0, 20);
          } catch (pdfErr) {
            if (status === 'success') {
              throw pdfErr;
            }
          }
        }

        if (synctexEntry?.url) {
          try {
            const stBuf = await this.#http.downloadBuildArtifact(synctexEntry.url, { clsiServerId });
            runtime.synctexIndex = parseSynctexGz(stBuf);
          } catch {}
        }

        const diagnostics = parseLatexLog(logText);
        if (status !== 'success' && diagnostics.errors.length === 0) {
          let stderrText = '';
          if (stderrEntry?.url) {
            try {
              const errBuf = await this.#http.downloadBuildArtifact(stderrEntry.url, { clsiServerId });
              stderrText = errBuf.toString('utf8');
            } catch {}
          }
          diagnostics.errors.push({
            severity: 'error',
            file: runtime.rootDocPath || null,
            line: null,
            message: res?.error || `Overleaf 云端编译失败 (${status})，请检查编译日志或 TeX 语法。`,
            snippet: (stderrText || logText).slice(-500),
          });
          diagnostics.summary.errorCount = diagnostics.errors.length;
          diagnostics.summary.ok = false;
        }

        runtime.compileResult = {
          status,
          ok: status === 'success' && diagnostics.summary.errorCount === 0,
          reason,
          durationMs: Date.now() - startedAt,
          compiledAt: Date.now(),
          hasPdf: Boolean(runtime.pdfBuffer),
          hasSynctex: Boolean(runtime.synctexIndex),
          pdfEtag: runtime.pdfEtag,
          diagnostics,
        };

        if (runtime.focusState?.file && runtime.synctexIndex && runtime.focusState.updatedBy !== 'system') {
          runtime.focusState = {
            ...runtime.focusState,
            highlight: forwardSync(runtime.synctexIndex, runtime.focusState.file, runtime.focusState.line),
          };
        }
        runtime.lastError = '';
        return runtime.compileResult;
      } catch (err) {
        runtime.lastError = err?.message || String(err);
        throw err;
      } finally {
        runtime.compiling = false;
        this.#bumpRevision();
      }
    };

    runtime.activeCompilePromise = execCompile();
    try {
      return await runtime.activeCompilePromise;
    } finally {
      runtime.activeCompilePromise = null;
    }
  }

  async saveDocFromUi(projectId, relPath, content) {
    const runtime = await this.ensureRuntime(projectId);
    const cleanPath = toPosix(relPath);
    const node = runtime.treeIndex.nodesByPath.get(cleanPath);
    if (!node || node.kind !== 'doc') {
      throw new Error(`找不到可编辑文档: ${cleanPath}`);
    }

    const normalized = normalizeNewlines(content);
    const doc = await runtime.realtime.joinDoc(node.id);
    if (doc.text !== normalized) {
      this.#recordUndoSnapshot(runtime, cleanPath, 'panel', `面板微调 ${cleanPath}`);
      const absPath = join(runtime.mirrorDir, ...cleanPath.split('/'));
      this.#writeMirrorText(runtime, cleanPath, absPath, normalized);
      await runtime.realtime.sendDocEdit(node.id, normalized);
      runtime.lastModifiedBy.set(cleanPath, 'panel');
      this.#scheduleAutoCompile(runtime);
      this.#bumpRevision();
    }
    return { saved: true, path: cleanPath, version: doc.version };
  }

  async getDocContent(projectId, relPath) {
    const runtime = await this.ensureRuntime(projectId);
    const cleanPath = toPosix(relPath);
    const node = runtime.treeIndex.nodesByPath.get(cleanPath);
    if (!node) throw new Error(`文件不存在: ${cleanPath}`);

    if (node.kind === 'doc') {
      const doc = await runtime.realtime.joinDoc(node.id);
      const undoEntry = runtime.lastUndoBatch?.files?.get(cleanPath);
      const diffLines = undoEntry && undoEntry.kind === 'doc'
        ? computeLineDiff(undoEntry.existed ? undoEntry.prevContent : '', doc.text)
        : null;
      return {
        path: cleanPath,
        docId: node.id,
        kind: 'doc',
        content: doc.text,
        version: doc.version,
        lastModifiedBy: runtime.lastModifiedBy.get(cleanPath) || '',
        diffLines,
      };
    }

    if (node.kind === 'file') {
      let buf = runtime.fileBuffers.get(cleanPath);
      if (!buf) {
        buf = await this.#http.downloadFile(runtime.projectId, node.id);
        runtime.fileBuffers.set(cleanPath, buf);
      }
      const mime = detectMimeType(cleanPath);
      const isImage = mime.startsWith('image/');
      const isPdf = mime === 'application/pdf';
      return {
        path: cleanPath,
        fileId: node.id,
        kind: 'file',
        mimeType: mime,
        size: buf.length,
        dataUrl: isImage && buf.length <= 4 * 1024 * 1024
          ? `data:${mime};base64,${buf.toString('base64')}`
          : '',
        pdfBase64: isPdf && buf.length <= 8 * 1024 * 1024
          ? buf.toString('base64')
          : '',
      };
    }

    throw new Error(`${cleanPath} 是文件夹`);
  }

  async entityAction({
    projectId,
    action,
    parentFolderId = '',
    parentPath = '',
    path = '',
    name = '',
    fileBase64 = '',
    confirmDelete = false,
  }) {
    const runtime = await this.ensureRuntime(projectId);
    const targetParentId =
      parentFolderId ||
      (parentPath ? runtime.treeIndex.folderIdByPath.get(toPosix(parentPath)) : '') ||
      runtime.treeIndex.rootFolderId;

    if (action === 'create_doc') {
      const cleanName = basename(String(name || '').trim());
      if (!cleanName) throw new Error('文件名不能为空');
      const created = await this.#http.createDoc(runtime.projectId, targetParentId, cleanName);
      const docId = String(created?._id || created?.id || '');
      if (docId) {
        this.#insertLocalTreeNode(runtime, targetParentId, 'doc', { _id: docId, name: cleanName });
        const node = runtime.treeIndex.nodesById.get(docId);
        if (node) {
          const doc = await runtime.realtime.joinDoc(docId);
          const absPath = join(runtime.mirrorDir, ...node.path.split('/'));
          this.#writeMirrorText(runtime, node.path, absPath, doc.text);
          this.#recordUndoSnapshot(runtime, node.path, 'panel', `新建 ${node.path}`);
          this.#updateFocusState(runtime, node.path, 1, 'panel');
        }
      }
      this.#bumpRevision();
      return { created: true, id: docId, path: runtime.treeIndex.nodesById.get(docId)?.path || cleanName };
    }

    if (action === 'create_folder') {
      const cleanName = basename(String(name || '').trim());
      if (!cleanName) throw new Error('文件夹名不能为空');
      const created = await this.#http.createFolder(runtime.projectId, targetParentId, cleanName);
      const folderId = String(created?._id || created?.id || '');
      if (folderId) {
        this.#insertLocalTreeNode(runtime, targetParentId, 'folder', {
          _id: folderId,
          name: cleanName,
          folders: [],
          docs: [],
          fileRefs: [],
        });
        const node = runtime.treeIndex.nodesById.get(folderId);
        if (node) {
          mkdirSync(join(runtime.mirrorDir, ...node.path.split('/')), { recursive: true });
        }
      }
      this.#bumpRevision();
      return { created: true, id: folderId, path: runtime.treeIndex.nodesById.get(folderId)?.path || cleanName };
    }

    if (action === 'upload_file') {
      const cleanName = basename(String(name || '').trim());
      if (!cleanName || !fileBase64) throw new Error('上传文件名与内容不能为空');
      const buf = Buffer.from(fileBase64, 'base64');
      const res = await this.#http.uploadFile(
        runtime.projectId,
        targetParentId,
        cleanName,
        buf,
        detectMimeType(cleanName)
      );
      const fileId = String(res?.entity_id || res?._id || '');
      if (fileId) {
        this.#insertLocalTreeNode(runtime, targetParentId, 'file', { _id: fileId, name: cleanName });
        const node = runtime.treeIndex.nodesById.get(fileId);
        if (node) {
          this.#recordUndoSnapshot(runtime, node.path, 'panel', `上传 ${node.path}`);
          const absPath = join(runtime.mirrorDir, ...node.path.split('/'));
          this.#writeMirrorBinary(runtime, node.path, absPath, buf);
          runtime.fileIndex = runtime.fileIndex || {};
          runtime.fileIndex[node.path] = { id: fileId, sha256: runtime.diskHashes.get(node.path) };
          this.#saveProjectConfig(runtime);
        }
      }
      this.#scheduleAutoCompile(runtime);
      this.#bumpRevision();
      return { uploaded: true, id: fileId, path: runtime.treeIndex.nodesById.get(fileId)?.path || cleanName };
    }

    if (action === 'delete') {
      const cleanPath = toPosix(path);
      const node = runtime.treeIndex.nodesByPath.get(cleanPath);
      if (!node) throw new Error(`找不到要删除的条目: ${cleanPath}`);
      const isRoot =
        node.id === runtime.rootDocId ||
        (runtime.rootDocPath && cleanPath === runtime.rootDocPath);
      if ((isRoot || node.kind === 'folder') && !confirmDelete) {
        throw new Error(`删除 ${cleanPath} 属于高风险操作，请确认后执行。`);
      }

      if (node.kind !== 'folder') {
        this.#recordUndoSnapshot(runtime, cleanPath, 'panel', `删除 ${cleanPath}`);
      }
      await this.#http.deleteEntity(runtime.projectId, node.kind, node.id);
      removeEntityFromProjectObj(runtime.project?.rootFolder?.[0], node.id);
      this.#refreshTreeIndex(runtime);

      const absPath = join(runtime.mirrorDir, ...cleanPath.split('/'));
      runtime.echoIgnoreUntil.set(cleanPath, Date.now() + ECHO_SUPPRESS_MS);
      runtime.diskHashes.delete(cleanPath);
      runtime.fileBuffers.delete(cleanPath);
      if (runtime.fileIndex && Object.hasOwn(runtime.fileIndex, cleanPath)) {
        delete runtime.fileIndex[cleanPath];
        this.#saveProjectConfig(runtime);
      }
      try { rmSync(absPath, { recursive: true, force: true }); } catch {}
      this.#scheduleAutoCompile(runtime);
      this.#bumpRevision();
      return { deleted: true, path: cleanPath };
    }

    throw new Error(`不支持的实体操作: ${action}`);
  }

  async undoLastBatch(projectId) {
    const runtime = await this.ensureRuntime(projectId);
    const batch = runtime.lastUndoBatch;
    if (!batch || batch.files.size === 0) {
      return { undone: false, message: '暂无可撤销的最近改动。' };
    }
    runtime.lastUndoBatch = null;

    const restoredPaths = [];
    for (const [relPath, entry] of batch.files.entries()) {
      const absPath = join(runtime.mirrorDir, ...relPath.split('/'));
      const node = runtime.treeIndex.nodesByPath.get(relPath);

      if (!entry.existed) {
        if (node) {
          await this.#http.deleteEntity(runtime.projectId, node.kind, node.id);
          removeEntityFromProjectObj(runtime.project?.rootFolder?.[0], node.id);
          this.#refreshTreeIndex(runtime);
        }
        runtime.echoIgnoreUntil.set(relPath, Date.now() + ECHO_SUPPRESS_MS);
        runtime.diskHashes.delete(relPath);
        runtime.fileBuffers.delete(relPath);
        try { if (existsSync(absPath)) unlinkSync(absPath); } catch {}
        restoredPaths.push(relPath);
        continue;
      }

      if (entry.kind === 'doc') {
        if (node?.kind === 'doc') {
          this.#writeMirrorText(runtime, relPath, absPath, entry.prevContent);
          await runtime.realtime.sendDocEdit(node.id, entry.prevContent);
        } else {
          const parentDir = dirname(relPath) === '.' ? '' : toPosix(dirname(relPath));
          const parentFolderId = await this.#ensureRemoteFolderPath(runtime, parentDir);
          const created = await this.#http.createDoc(runtime.projectId, parentFolderId, basename(relPath));
          const docId = String(created?._id || created?.id || '');
          if (docId) {
            this.#insertLocalTreeNode(runtime, parentFolderId, 'doc', { _id: docId, name: basename(relPath) });
            await runtime.realtime.joinDoc(docId);
            this.#writeMirrorText(runtime, relPath, absPath, entry.prevContent);
            await runtime.realtime.sendDocEdit(docId, entry.prevContent);
          }
        }
        runtime.lastModifiedBy.set(relPath, 'undo');
        restoredPaths.push(relPath);
      } else if (entry.kind === 'file' && entry.prevBuffer) {
        const parentDir = dirname(relPath) === '.' ? '' : toPosix(dirname(relPath));
        const parentFolderId = node?.parentFolderId || (await this.#ensureRemoteFolderPath(runtime, parentDir));
        const res = await this.#http.uploadFile(
          runtime.projectId,
          parentFolderId,
          basename(relPath),
          entry.prevBuffer,
          detectMimeType(relPath)
        );
        const fileId = String(res?.entity_id || res?._id || node?.id || '');
        if (fileId) {
          this.#insertLocalTreeNode(runtime, parentFolderId, 'file', { _id: fileId, name: basename(relPath) });
          runtime.fileIndex = runtime.fileIndex || {};
          runtime.fileIndex[relPath] = { id: fileId, sha256: sha256(entry.prevBuffer) };
          this.#saveProjectConfig(runtime);
        }
        this.#writeMirrorBinary(runtime, relPath, absPath, entry.prevBuffer);
        restoredPaths.push(relPath);
      }
    }

    this.#scheduleAutoCompile(runtime);
    this.#bumpRevision();
    return { undone: true, restoredPaths, description: batch.description };
  }

  async focusLocation({ projectId, file, line = 1, updatedBy = 'agent' }) {
    const runtime = await this.ensureRuntime(projectId);
    const cleanPath = toPosix(file);
    this.#updateFocusState(runtime, cleanPath, line, updatedBy);
    this.#bumpRevision();
    return runtime.focusState;
  }

  async forwardSync(projectId, relPath, line) {
    const runtime = await this.ensureRuntime(projectId);
    if (!runtime.synctexIndex) return null;
    return forwardSync(runtime.synctexIndex, toPosix(relPath), Number(line) || 1);
  }

  async inverseSync(projectId, page, xPt, yTopPt) {
    const runtime = await this.ensureRuntime(projectId);
    if (!runtime.synctexIndex) return null;
    return inverseSync(runtime.synctexIndex, Number(page), Number(xPt), Number(yTopPt), {
      fileFilter: (f) => runtime.treeIndex.nodesByPath.has(f),
    });
  }

  updateSettings({ projectId, autoCompile, debounceMs, conversationId }) {
    const runtime = this.#runtimes.get(extractProjectId(projectId));
    if (!runtime) throw new Error('项目尚未连接');
    if (typeof autoCompile === 'boolean') runtime.autoCompile = autoCompile;
    if (Number.isFinite(Number(debounceMs)) && Number(debounceMs) >= 500) {
      runtime.debounceMs = Math.trunc(Number(debounceMs));
    }
    if (conversationId) {
      this.#config.bindings[conversationId] = runtime.projectId;
    }
    this.#saveProjectConfig(runtime);
    this.#bumpRevision();
    return {
      projectId: runtime.projectId,
      autoCompile: runtime.autoCompile,
      debounceMs: runtime.debounceMs,
    };
  }

  dismissGuardrail(projectId) {
    const runtime = this.#runtimes.get(extractProjectId(projectId));
    if (runtime) {
      runtime.guardrailAlert = null;
      this.#bumpRevision();
    }
  }

  getPdfBuffer(projectId) {
    const runtime = this.#runtimes.get(extractProjectId(projectId));
    if (!runtime || !runtime.pdfBuffer) return null;
    return { buffer: runtime.pdfBuffer, etag: runtime.pdfEtag };
  }

  #maybeAutoReconnect(projectId, conversationId = '') {
    if (!projectId || !this.#jar.isAuthenticated()) return;
    const savedCfg = this.#config.projects?.[projectId];
    if (!savedCfg) return;
    if (this.#runtimes.has(projectId)) return;
    if (this.#autoReconnecting.has(projectId) || this.#autoReconnectAttempted.has(projectId)) return;

    this.#autoReconnecting.add(projectId);
    this.#autoReconnectAttempted.add(projectId);
    this.#bumpRevision();

    this.connectProject({
      projectId,
      conversationId,
      mirrorDir: savedCfg.mirrorDir || '',
      autoInitialCompile: true,
    })
      .catch(() => {})
      .finally(() => {
        this.#autoReconnecting.delete(projectId);
        this.#bumpRevision();
      });
  }

  getUiState({ conversationId = '', projectId = '', etag = '' } = {}) {
    const boundProjectId = conversationId ? this.#config.bindings[conversationId] || '' : '';
    const activeProjectId = extractProjectId(projectId) || boundProjectId || this.resolveProjectId({ conversationId });
    const runtime = activeProjectId ? this.#runtimes.get(activeProjectId) || null : null;

    if (!runtime && activeProjectId) {
      this.#maybeAutoReconnect(activeProjectId, conversationId);
    }
    const reconnectingProjectId =
      activeProjectId &&
      !runtime &&
      (this.#autoReconnecting.has(activeProjectId) || this.#connectingPromises.has(activeProjectId))
        ? activeProjectId
        : '';

    const computedEtag = `${this.#revision}:${activeProjectId}:${reconnectingProjectId}:${runtime?.realtime?.status || ''}:${runtime?.compiling ? 1 : 0}`;
    if (etag && etag === computedEtag) {
      return { unchanged: true, etag: computedEtag };
    }

    const connectedProjects = [...this.#runtimes.values()].map((r) => ({
      id: r.projectId,
      name: r.projectName,
      mirrorDir: r.mirrorDir,
      status: r.realtime.status,
      autoCompile: r.autoCompile,
    }));

    // Also include previously configured projects so dropdown remembers them
    const configuredProjects = Object.values(this.#config.projects || {}).map((p) => ({
      id: p.id,
      name: p.name,
      mirrorDir: p.mirrorDir,
      connected: this.#runtimes.has(p.id),
    }));

    return {
      etag: computedEtag,
      auth: this.getAuthStatus(),
      conversationId,
      boundProjectId,
      activeProjectId,
      reconnectingProjectId,
      connectedProjects,
      configuredProjects,
      projectsList: this.#projectsCache,
      activeProject: runtime
        ? {
            id: runtime.projectId,
            name: runtime.projectName,
            mirrorDir: runtime.mirrorDir,
            syncStatus: runtime.compiling ? 'compiling' : runtime.realtime.status,
            autoCompile: runtime.autoCompile,
            debounceMs: runtime.debounceMs,
            rootFolderId: runtime.treeIndex.rootFolderId,
            rootDocId: runtime.rootDocId,
            rootDocPath: runtime.rootDocPath,
            compileTargetDocId: runtime.compileTargetDocId || runtime.rootDocId,
            compileTargetPath: runtime.compileTargetPath || runtime.rootDocPath,
            tree: runtime.treeIndex.tree,
            compiling: runtime.compiling,
            compileResult: runtime.compileResult,
            undoAvailable: Boolean(runtime.lastUndoBatch && runtime.lastUndoBatch.files.size > 0),
            undoSummary: runtime.lastUndoBatch
              ? {
                  id: runtime.lastUndoBatch.id,
                  description: runtime.lastUndoBatch.description,
                  files: [...runtime.lastUndoBatch.files.keys()],
                  timestamp: runtime.lastUndoBatch.timestamp,
                }
              : null,
            guardrailAlert: runtime.guardrailAlert,
            lastError: runtime.lastError,
            focusState: runtime.focusState,
          }
        : null,
    };
  }
}

function findFirstChangedLine(oldText, newText) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) return i + 1;
  }
  return limit + 1;
}

export async function dispatchIpcAction(sync, action, params = {}) {
  const convId = String(params.conversationId || '').trim();
  const resolveId = () =>
    sync.resolveProjectId({ projectId: params.projectId, conversationId: convId });

  switch (action) {
    case 'status': {
      return sync.getUiState({
        conversationId: convId,
        projectId: String(params.projectId || '').trim(),
      });
    }
    case 'list_projects': {
      const projects = await sync.listProjects({
        refresh: Boolean(params.refresh),
        query: String(params.query || ''),
      });
      return { projects };
    }
    case 'connect_project': {
      const runtime = await sync.connectProject({
        projectId: params.projectId,
        conversationId: convId,
        mirrorDir: params.mirrorDir,
        autoInitialCompile: params.autoInitialCompile !== false,
      });
      return {
        projectId: runtime.projectId,
        projectName: runtime.projectName,
        mirrorDir: runtime.mirrorDir,
        rootDocPath: runtime.rootDocPath,
        tree: runtime.treeIndex.tree,
      };
    }
    case 'compile': {
      return sync.runCloudCompile(resolveId(), {
        draft: Boolean(params.draft),
        reason: String(params.reason || 'agent'),
        targetFile: params.targetFile ? String(params.targetFile) : '',
      });
    }
    case 'focus': {
      return sync.focusLocation({
        projectId: resolveId(),
        file: String(params.file || ''),
        line: Number(params.line || 1),
        updatedBy: 'agent',
      });
    }
    case 'file_ops': {
      return sync.entityAction({
        projectId: resolveId(),
        action: params.op,
        parentPath: params.parentPath,
        parentFolderId: params.parentFolderId,
        path: params.path,
        name: params.name,
        fileBase64: params.fileBase64,
        confirmDelete: Boolean(params.confirmDelete),
      });
    }
    case 'undo': {
      return sync.undoLastBatch(resolveId());
    }
    default:
      throw new Error(`未知的 IPC 动作: ${action}`);
  }
}
