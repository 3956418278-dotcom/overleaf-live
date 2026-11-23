/**
 * Overleaf Live Sidecar Backend (`overleaf-live/overleaf_live`).
 *
 * Hosts:
 *  1. `SidecarApp` web UI + API routes for the native Antigravity Auxiliary Pane
 *  2. Loopback authenticated IPC server (`STATE_DIR/daemon.json`) so the
 *     stdio MCP server (`mcp/mcp_server.mjs`) shares the live `SyncManager`,
 *     Socket.IO OT connections, PDF buffers, and SyncTeX indices in real time.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { AuthError } from './lib/overleaf_client.mjs';
import { clearDaemonInfo, writeDaemonInfo } from './lib/state_store.mjs';
import { SyncManager, dispatchIpcAction } from './lib/sync_manager.mjs';

export { dispatchIpcAction };

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/vendor/pdf.min.mjs', ['vendor/pdf.min.mjs', 'application/javascript; charset=utf-8']],
  ['/vendor/pdf.worker.min.mjs', ['vendor/pdf.worker.min.mjs', 'application/javascript; charset=utf-8']],
]);

function jsonError(err, defaultStatus = 400) {
  const status = err instanceof AuthError ? 401 : defaultStatus;
  return new Response(JSON.stringify({ error: err?.message || String(err) }), {
    status,
    contentType: 'application/json; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
  });
}

function createStaticHandler(relPath, contentType) {
  return () => {
    try {
      const body = readFileSync(join(__dirname, relPath));
      return new Response(body, {
        contentType,
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch {
      return new Response('Not found', {
        status: 404,
        contentType: 'text/plain; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
      });
    }
  };
}

export function registerRoutes(app, sync, { defaultConversationId = '' } = {}) {
  for (const [route, [relPath, contentType]] of STATIC_FILES.entries()) {
    app.page(route, createStaticHandler(relPath, contentType));
  }

  const resolveConv = (data) =>
    String(data?.conversationId || defaultConversationId || '').trim();

  app.api(
    '/api/state',
    (data) => {
      try {
        return sync.getUiState({
          conversationId: resolveConv(data),
          projectId: String(data?.projectId || '').trim(),
          etag: String(data?.etag || '').trim(),
        });
      } catch (err) {
        return jsonError(err, 500);
      }
    },
    'GET'
  );

  app.api(
    '/api/projects',
    async (data) => {
      try {
        const projects = await sync.listProjects({
          refresh: data?.refresh === '1' || data?.refresh === true,
          query: String(data?.query || ''),
        });
        return { projects };
      } catch (err) {
        return jsonError(err, 400);
      }
    },
    'GET'
  );

  app.api(
    '/api/doc',
    async (data) => {
      try {
        const projectId = sync.resolveProjectId({
          projectId: data?.projectId,
          conversationId: resolveConv(data),
        });
        return await sync.getDocContent(projectId, String(data?.path || ''));
      } catch (err) {
        return jsonError(err, 400);
      }
    },
    'GET'
  );

  app.api(
    '/api/pdf',
    (data) => {
      const projectId = sync.resolveProjectId({
        projectId: data?.projectId,
        conversationId: resolveConv(data),
      });
      const pdf = projectId ? sync.getPdfBuffer(projectId) : null;
      if (!pdf) {
        return new Response('No compiled PDF yet', {
          status: 404,
          contentType: 'text/plain; charset=utf-8',
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      return new Response(pdf.buffer, {
        status: 200,
        contentType: 'application/pdf',
        headers: {
          'Cache-Control': 'no-store',
          ETag: pdf.etag,
        },
      });
    },
    'GET'
  );

  app.api('/api/auth/cookie', async (data) => {
    try {
      return await sync.setCookieAuth({
        cookieInput: data?.cookieInput,
        baseUrl: data?.baseUrl,
      });
    } catch (err) {
      return jsonError(err, 400);
    }
  });

  app.api('/api/auth/popup', async (data) => {
    try {
      if (data?.action === 'cancel') {
        return sync.cancelPopupAuth();
      }
      return await sync.startPopupAuth({ baseUrl: data?.baseUrl });
    } catch (err) {
      return jsonError(err, 400);
    }
  });

  app.api('/api/auth/logout', () => {
    try {
      return sync.logout();
    } catch (err) {
      return jsonError(err, 500);
    }
  });

  app.api('/api/project/connect', async (data) => {
    try {
      const convId = resolveConv(data);
      const runtime = await sync.connectProject({
        projectId: data?.projectId,
        conversationId: convId,
        mirrorDir: data?.mirrorDir,
        autoInitialCompile: data?.autoInitialCompile !== false,
      });
      return {
        connected: true,
        projectId: runtime.projectId,
        projectName: runtime.projectName,
        mirrorDir: runtime.mirrorDir,
        rootDocPath: runtime.rootDocPath,
      };
    } catch (err) {
      return jsonError(err, 400);
    }
  });

  app.api('/api/project/settings', (data) => {
    try {
      const convId = resolveConv(data);
      const projectId = sync.resolveProjectId({
        projectId: data?.projectId,
        conversationId: convId,
      });
      return sync.updateSettings({
        projectId,
        autoCompile: data?.autoCompile,
        debounceMs: data?.debounceMs,
        conversationId: data?.bindConversation ? convId : '',
      });
    } catch (err) {
      return jsonError(err, 400);
    }
  });

  app.api('/api/doc/save', async (data) => {
    try {
      const projectId = sync.resolveProjectId({
        projectId: data?.projectId,
        conversationId: resolveConv(data),
      });
      return await sync.saveDocFromUi(projectId, String(data?.path || ''), String(data?.content ?? ''));
    } catch (err) {
      return jsonError(err, 400);
    }
  });

  app.api('/api/entity/action', async (data) => {
    try {
      const projectId = sync.resolveProjectId({
        projectId: data?.projectId,
        conversationId: resolveConv(data),
      });
      return await sync.entityAction({
        projectId,
        action: data?.action,
        parentFolderId: data?.parentFolderId,
        parentPath: data?.parentPath,
        path: data?.path,
        name: data?.name,
        fileBase64: data?.fileBase64,
        confirmDelete: Boolean(data?.confirmDelete),
      });
    } catch (err) {
      return jsonError(err, 400);
    }
  });

  app.api('/api/compile', async (data) => {
    try {
      const projectId = sync.resolveProjectId({
        projectId: data?.projectId,
        conversationId: resolveConv(data),
      });
      return await sync.runCloudCompile(projectId, {
        draft: Boolean(data?.draft),
        reason: String(data?.reason || 'manual'),
        targetFile: data?.targetFile ? String(data.targetFile) : '',
      });
    } catch (err) {
      return jsonError(err, 400);
    }
  });

  app.api('/api/compile/target', async (data) => {
    try {
      const projectId = sync.resolveProjectId({
        projectId: data?.projectId,
        conversationId: resolveConv(data),
      });
      return await sync.setCompileTarget(projectId, String(data?.path || ''));
    } catch (err) {
      return jsonError(err, 400);
    }
  });

  app.api('/api/synctex/forward', async (data) => {
    try {
      const projectId = sync.resolveProjectId({
        projectId: data?.projectId,
        conversationId: resolveConv(data),
      });
      const hit = await sync.forwardSync(projectId, String(data?.file || ''), Number(data?.line || 1));
      return { hit };
    } catch (err) {
      return jsonError(err, 400);
    }
  });

  app.api('/api/synctex/inverse', async (data) => {
    try {
      const projectId = sync.resolveProjectId({
        projectId: data?.projectId,
        conversationId: resolveConv(data),
      });
      const hit = await sync.inverseSync(
        projectId,
        Number(data?.page || 1),
        Number(data?.xPt || 0),
        Number(data?.yTopPt || 0)
      );
      return { hit };
    } catch (err) {
      return jsonError(err, 400);
    }
  });

  app.api('/api/focus', async (data) => {
    try {
      const projectId = sync.resolveProjectId({
        projectId: data?.projectId,
        conversationId: resolveConv(data),
      });
      return await sync.focusLocation({
        projectId,
        file: String(data?.file || ''),
        line: Number(data?.line || 1),
        updatedBy: String(data?.updatedBy || 'agent'),
      });
    } catch (err) {
      return jsonError(err, 400);
    }
  });

  app.api('/api/undo', async (data) => {
    try {
      const projectId = sync.resolveProjectId({
        projectId: data?.projectId,
        conversationId: resolveConv(data),
      });
      return await sync.undoLastBatch(projectId);
    } catch (err) {
      return jsonError(err, 400);
    }
  });

  app.api('/api/guardrail/dismiss', (data) => {
    const projectId = sync.resolveProjectId({
      projectId: data?.projectId,
      conversationId: resolveConv(data),
    });
    if (projectId) sync.dismissGuardrail(projectId);
    return { ok: true };
  });
}

/**
 * Starts the authenticated loopback IPC server used by `mcp/mcp_server.mjs`.
 */
export function startIpcBridge(sync, { writeDaemonFile = true } = {}) {
  const token = randomBytes(24).toString('hex');

  const ipcServer = createServer(async (req, res) => {
    const provided = req.headers['x-overleaf-ipc-token'];
    if (provided !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized IPC request' }));
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/ipc/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, revision: sync.revision }));
      return;
    }

    if (req.method !== 'POST' || url.pathname !== '/ipc/call') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      try {
        const { action, params = {} } = JSON.parse(raw || '{}');
        const result = await dispatchIpcAction(sync, action, params);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (err) {
        const status = err instanceof AuthError ? 401 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      }
    });
  });

  return new Promise((resolve) => {
    ipcServer.listen(0, '127.0.0.1', () => {
      const addr = ipcServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const info = {
        pid: process.pid,
        host: '127.0.0.1',
        port,
        token,
        startedAt: Date.now(),
      };
      if (writeDaemonFile) writeDaemonInfo(info);
      resolve({ ipcServer, info });
    });
  });
}

async function main() {
  const app = new SidecarApp();
  const sync = new SyncManager();

  registerRoutes(app, sync, { defaultConversationId: app.config.conversationId || '' });

  const { ipcServer } = await startIpcBridge(sync, { writeDaemonFile: true });
  await app.run();

  const shutdown = () => {
    clearDaemonInfo();
    sync.closeAll();
    try { ipcServer.close(); } catch {}
    app.close().finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => {
    clearDaemonInfo();
  });
}

const isEntrypoint =
  process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase();

if (isEntrypoint) {
  main().catch((err) => {
    console.error('[overleaf-live sidecar fatal]', err);
    clearDaemonInfo();
    process.exit(1);
  });
}
