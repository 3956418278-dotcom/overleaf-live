#!/usr/bin/env node
/**
 * Comprehensive offline verification & integration suite for `overleaf-live`.
 * Uses isolated temporary `OVERLEAF_LIVE_STATE_DIR` and `OVERLEAF_LIVE_MIRROR_ROOT`,
 * plus a local HTTP + RFC6455 WebSocket Socket.IO v0.9 Mock Overleaf server.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Script } from 'node:vm';
import { gzipSync } from 'node:zlib';

// Isolate plugin state & mirrors completely from real user config before importing modules.
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'overleaf-live-test-'));
const TEST_STATE_DIR = join(TEST_ROOT, 'state');
const TEST_MIRROR_ROOT = join(TEST_ROOT, 'mirrors');
mkdirSync(TEST_STATE_DIR, { recursive: true });
mkdirSync(TEST_MIRROR_ROOT, { recursive: true });

process.env.OVERLEAF_LIVE_STATE_DIR = TEST_STATE_DIR;
process.env.OVERLEAF_LIVE_MIRROR_ROOT = TEST_MIRROR_ROOT;
process.env.OVERLEAF_MCP_IMPORT_ONLY = '1';

const { findChromeBinary } = await import('../lib/auth.mjs');
const { parseLatexLog } = await import('../lib/log_parser.mjs');
const { applyOp, diffToOp, normalizeNewlines, transformX } = await import('../lib/ot_diff.mjs');
const { decodeOverleafLine } = await import('../lib/overleaf_client.mjs');
const { parseSynctexGz, forwardSync, inverseSync } = await import('../lib/synctex_parser.mjs');
const { SyncManager } = await import('../lib/sync_manager.mjs');
const { loadConfig, saveConfig } = await import('../lib/state_store.mjs');
const { dispatchIpcAction, registerRoutes, startIpcBridge } = await import('../main.mjs');
const { handleJsonRpcRequest } = await import('../../../mcp/mcp_server.mjs');

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 40, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function buildSampleSynctexGz() {
  // Coordinates use 65536 scaled points per TeX point (`Magnification:1000`, `Unit:1`).
  // Sheet 1: full-page outer vbox (line 999), main.tex line 50 (tests preamble >5 lines fallback),
  // sections/method.tex line 14 at (120, 240)pt, and output.bbl line 5 (tests fileFilter).
  const pt = (v) => Math.round(v * 65536);
  const lines = [
    'SyncTeX Version:1',
    'Input:1:./main.tex',
    'Input:2:./sections/method.tex',
    'Input:3:./output.bbl',
    'Output:pdf',
    'Magnification:1000',
    'Unit:1',
    'X Offset:0',
    'Y Offset:0',
    'Content:',
    '{1',
    `[1,999:${pt(40)},${pt(750)}:${pt(520)},${pt(700)},${pt(0)}`,
    `h1,50:${pt(72)},${pt(100)}:${pt(220)},${pt(14)},${pt(2)}`,
    `h2,14:${pt(120)},${pt(240)}:${pt(260)},${pt(16)},${pt(4)}`,
    `x2,14:${pt(120)},${pt(240)}`,
    `h3,5:${pt(100)},${pt(400)}:${pt(200)},${pt(14)},${pt(2)}`,
    ']',
    '}1',
    'Postamble:',
    'Count:5',
    '!10',
    'Post scriptum:',
  ].join('\n');
  return gzipSync(Buffer.from(lines, 'utf8'));
}

function buildMinimalPdf() {
  return Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'utf8');
}

function encodeHtmlAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Minimal RFC 6455 WebSocket frame encoder/decoder for `node:http` upgrade sockets.
 */
function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function attachWsDecoder(socket, { onText, onClose }) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (buf.length < offset + 2) return;
        payloadLen = buf.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (buf.length < offset + 8) return;
        payloadLen = Number(buf.readBigUInt64BE(offset));
        offset += 8;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + payloadLen) return;
      const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
      offset += maskLen;
      const payload = Buffer.from(buf.subarray(offset, offset + payloadLen));
      buf = buf.subarray(offset + payloadLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x8) {
        try { socket.end(Buffer.from([0x88, 0x00])); } catch {}
        onClose?.();
        return;
      }
      if (opcode === 0x9) {
        // Respond to Ping with Pong
        try {
          const pongHead = Buffer.from([0x8a, payload.length]);
          socket.write(Buffer.concat([pongHead, payload]));
        } catch {}
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        onText(payload.toString('utf8'));
      }
    }
  });
  socket.on('close', () => onClose?.());
  socket.on('error', () => onClose?.());
}

/**
 * Full Mock Overleaf HTTP + Socket.IO v0.9 WebSocket Server.
 */
async function createMockOverleafServer() {
  const projectId = '65a1b2c3d4e5f60718293a4b';
  const rootFolderId = 'fld-root-1';
  const sectionsFolderId = 'fld-sec-2';
  const figuresFolderId = 'fld-fig-3';
  const mainDocId = 'doc-main-1';
  const introDocId = 'doc-intro-2';
  const methodDocId = 'doc-method-3';
  const figFileId = 'file-fig-1';
  const expectedCookie = 'mock-session-xyz';
  const csrfToken = 'mock-csrf-token-999';

  let entityCounter = 100;
  const docs = new Map([
    [
      mainDocId,
      {
        id: mainDocId,
        version: 3,
        text: '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\input{sections/method}\n\\end{document}',
      },
    ],
    [
      introDocId,
      {
        id: introDocId,
        version: 5,
        text: '\\section{Introduction}\nHello Overleaf research workflow.',
      },
    ],
    [
      methodDocId,
      {
        id: methodDocId,
        version: 2,
        text: '\\section{Method}\n% Chinese UTF-8 check\n深度学习实验方法。',
      },
    ],
  ]);

  const files = new Map([
    [figFileId, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])],
  ]);

  const rootFolder = {
    _id: rootFolderId,
    name: 'rootFolder',
    folders: [
      {
        _id: sectionsFolderId,
        name: 'sections',
        folders: [],
        docs: [
          { _id: introDocId, name: 'intro.tex' },
          { _id: methodDocId, name: 'method.tex' },
        ],
        fileRefs: [],
      },
      {
        _id: figuresFolderId,
        name: 'figures',
        folders: [],
        docs: [],
        fileRefs: [{ _id: figFileId, name: 'arch.png' }],
      },
    ],
    docs: [{ _id: mainDocId, name: 'main.tex' }],
    fileRefs: [],
  };

  function findFolder(folder, id) {
    if (folder._id === id) return folder;
    for (const sub of folder.folders) {
      const f = findFolder(sub, id);
      if (f) return f;
    }
    return null;
  }

  function removeEntity(folder, id) {
    for (const k of ['docs', 'fileRefs', 'folders']) {
      const idx = folder[k].findIndex((x) => x._id === id);
      if (idx >= 0) {
        folder[k].splice(idx, 1);
        return true;
      }
    }
    return folder.folders.some((sub) => removeEntity(sub, id));
  }

  const clsiServerId = 'clsi-mock-pod-42';
  const state = {
    compileCount: 0,
    uploadCount: 0,
    fileDownloadAttempts: 0,
    fileDownloadDelayMs: 0,
    failFileDownloadsMode: 'none',
    lastCompileStatus: 'success',
    receivedOtUpdates: [],
    deletedIds: [],
    lastPdf: buildMinimalPdf(),
    lastSynctexGz: buildSampleSynctexGz(),
    lastLog: 'This is pdfTeX\n(./main.tex\n(./sections/intro.tex)\nOutput written on output.pdf (1 page).\n',
    sockets: new Set(),
  };

  const hasValidAuth = (req) => String(req.headers.cookie || '').includes(`overleaf_session2=${expectedCookie}`);

  const sendSocketEvent = (socket, name, args) => {
    socket.write(encodeWsTextFrame(`5:::${JSON.stringify({ name, args })}`));
  };

  const broadcastEvent = (name, args) => {
    const packet = encodeWsTextFrame(`5:::${JSON.stringify({ name, args })}`);
    for (const s of state.sockets) {
      try { s.write(packet); } catch {}
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/login') {
      if (hasValidAuth(req)) {
        res.writeHead(302, { Location: '/project' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'overleaf_session2=anon-unauthenticated-session; Path=/; HttpOnly',
      });
      res.end(
        `<!doctype html><html><head><title>Log in to Overleaf</title>` +
          `<meta name="ol-csrfToken" content="anon-csrf-token">` +
          `<meta name="ol-usersEmail" content="">` +
          `<meta name="ol-user_id">` +
          `</head><body><h1>Log in to Overleaf</h1></body></html>`
      );
      return;
    }

    if (!hasValidAuth(req)) {
      if (req.method === 'GET' && (path === '/project' || path.startsWith('/project/'))) {
        res.writeHead(302, {
          Location: '/login?',
          'Set-Cookie': 'overleaf_session2=anon-unauthenticated-session; Path=/; HttpOnly',
        });
        res.end();
        return;
      }
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }

    if (req.method === 'GET' && path === '/project') {
      const blob = encodeHtmlAttr(
        JSON.stringify({
          projects: [
            {
              id: projectId,
              name: 'Mock Quantum Paper',
              lastUpdated: '2026-11-15T08:00:00Z',
              accessLevel: 'owner',
              archived: false,
              trashed: false,
            },
          ],
        })
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head>` +
          `<meta name="ol-csrfToken" content="${csrfToken}">` +
          `<meta name="ol-user_id" content="usr-mock-1">` +
          `<meta name="ol-usersEmail" content="researcher@example.com">` +
          `<meta name="ol-prefetchedProjectsBlob" content="${blob}">` +
          `</head><body>Projects</body></html>`
      );
      return;
    }

    if (req.method === 'GET' && path === `/project/${projectId}`) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'GCLB=mock-sticky-node-1; Path=/; HttpOnly',
      });
      res.end(
        `<!doctype html><html><head>` +
          `<meta name="ol-csrfToken" content="${csrfToken}">` +
          `<meta name="ol-usersEmail" content="researcher@example.com">` +
          `</head><body>Project</body></html>`
      );
      return;
    }

    if (req.method === 'GET' && path === '/socket.io/1/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('mock-ws-sid-1:60:60:websocket');
      return;
    }

    const fileDownloadMatch = path.match(new RegExp(`^/project/${projectId}/file/([^/]+)$`));
    if (req.method === 'GET' && fileDownloadMatch) {
      state.fileDownloadAttempts += 1;
      if (state.fileDownloadDelayMs > 0) {
        await delay(state.fileDownloadDelayMs);
      }
      if (state.failFileDownloadsMode === 'transient-429-once') {
        state.failFileDownloadsMode = 'none';
        res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '0.05' });
        res.end('Rate limited');
        return;
      }
      if (state.failFileDownloadsMode === 'always-429') {
        res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '0.05' });
        res.end('Rate limited');
        return;
      }
      const buf = files.get(decodeURIComponent(fileDownloadMatch[1]));
      if (!buf) {
        res.writeHead(404);
        res.end('Missing file');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(buf);
      return;
    }

    const hasValidClsi = () => url.searchParams.get('clsiserverid') === clsiServerId;
    if (req.method === 'GET' && path === '/build/output.pdf') {
      if (!hasValidClsi() || state.lastCompileStatus !== 'success') {
        res.writeHead(404);
        res.end('Missing clsiServerId or no PDF on failed build');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(state.lastPdf);
      return;
    }
    if (req.method === 'GET' && path === '/build/output.log') {
      if (!hasValidClsi()) {
        res.writeHead(404);
        res.end('Missing clsiServerId');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(state.lastLog);
      return;
    }
    if (req.method === 'GET' && path === '/build/output.synctex.gz') {
      if (!hasValidClsi()) {
        res.writeHead(404);
        res.end('Missing clsiServerId');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/gzip' });
      res.end(state.lastSynctexGz);
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyBuf = Buffer.concat(chunks);

    if (req.method === 'POST' && path === `/project/${projectId}/doc`) {
      assert.equal(req.headers['x-csrf-token'], csrfToken, 'createDoc missing CSRF header');
      const payload = JSON.parse(bodyBuf.toString('utf8'));
      const newId = `doc-new-${++entityCounter}`;
      docs.set(newId, { id: newId, version: 0, text: '' });
      const parent = findFolder(rootFolder, payload.parent_folder_id || rootFolderId) || rootFolder;
      parent.docs.push({ _id: newId, name: payload.name });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ _id: newId, name: payload.name }));
      return;
    }

    if (req.method === 'POST' && path === `/project/${projectId}/folder`) {
      assert.equal(req.headers['x-csrf-token'], csrfToken, 'createFolder missing CSRF header');
      const payload = JSON.parse(bodyBuf.toString('utf8'));
      const newId = `fld-new-${++entityCounter}`;
      const entity = { _id: newId, name: payload.name, folders: [], docs: [], fileRefs: [] };
      const parent = findFolder(rootFolder, payload.parent_folder_id || rootFolderId) || rootFolder;
      parent.folders.push(entity);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entity));
      return;
    }

    if (req.method === 'POST' && path === `/project/${projectId}/upload`) {
      assert.equal(req.headers['x-csrf-token'], csrfToken, 'upload missing CSRF header');
      state.uploadCount += 1;
      const folderId = url.searchParams.get('folder_id') || rootFolderId;
      const newId = `file-new-${++entityCounter}`;
      const rawStr = bodyBuf.toString('latin1');
      const nameMatch = rawStr.match(/name="name"\r\n\r\n([^\r\n]+)/);
      const fname = nameMatch ? nameMatch[1] : `upload-${entityCounter}.bin`;
      files.set(newId, bodyBuf);
      const parent = findFolder(rootFolder, folderId) || rootFolder;
      parent.fileRefs.push({ _id: newId, name: fname });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, entity_id: newId }));
      return;
    }

    const delMatch = path.match(new RegExp(`^/project/${projectId}/(doc|file|folder)/([^/]+)$`));
    if (req.method === 'DELETE' && delMatch) {
      assert.equal(req.headers['x-csrf-token'], csrfToken, 'delete missing CSRF header');
      const targetId = decodeURIComponent(delMatch[2]);
      state.deletedIds.push(targetId);
      docs.delete(targetId);
      files.delete(targetId);
      removeEntity(rootFolder, targetId);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && path === `/project/${projectId}/settings`) {
      assert.equal(req.headers['x-csrf-token'], csrfToken, 'settings missing CSRF header');
      const body = JSON.parse(bodyBuf.toString('utf8') || '{}');
      const nextRootDocId = body.rootDocId || body.rootDoc_id;
      if (nextRootDocId) {
        state.lastRootDocId = String(nextRootDocId);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rootDoc_id: state.lastRootDocId || mainDocId }));
      return;
    }

    if (req.method === 'POST' && path === `/project/${projectId}/compile`) {
      assert.equal(req.headers['x-csrf-token'], csrfToken, 'compile missing CSRF header');
      const compileBody = JSON.parse(bodyBuf.toString('utf8') || '{}');
      state.lastCompiledRootDocId = String(compileBody.rootDoc_id || state.lastRootDocId || mainDocId);
      state.lastCompileIncremental = Boolean(compileBody.incrementalCompilesEnabled);
      state.compileCount += 1;
      const hasBadMacro = [...docs.values()].some((d) => d.text.includes('\\badmacro'));
      if (hasBadMacro) {
        state.lastCompileStatus = 'failure';
        state.lastLog = 'This is pdfTeX\n(./sections/intro.tex\n! Undefined control sequence.\nl.88 \\badmacro\n';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'failure',
            clsiServerId,
            outputFiles: [
              { type: 'pdf', url: '/build/output.pdf', path: 'output.pdf' },
              { type: 'log', url: '/build/output.log', path: 'output.log' },
            ],
          })
        );
        return;
      }
      state.lastCompileStatus = 'success';
      state.lastLog = 'This is pdfTeX\n(./main.tex\n(./sections/intro.tex)\nOutput written on output.pdf (1 page).\n';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'success',
          clsiServerId,
          outputFiles: [
            { type: 'pdf', url: '/build/output.pdf', path: 'output.pdf' },
            { type: 'log', url: '/build/output.log', path: 'output.log' },
            { type: 'gz', url: '/build/output.synctex.gz', path: 'output.synctex.gz' },
          ],
        })
      );
      return;
    }

    res.writeHead(404);
    res.end(`Unhandled mock HTTP route: ${req.method} ${path}`);
  });

  server.on('upgrade', (req, socket) => {
    const wsKey = req.headers['sec-websocket-key'];
    const accept = createHash('sha1')
      .update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n')
    );

    state.sockets.add(socket);

    attachWsDecoder(socket, {
      onClose: () => state.sockets.delete(socket),
      onText: (raw) => {
        if (raw.startsWith('2::')) {
          socket.write(encodeWsTextFrame('2::'));
          return;
        }
        const match = raw.match(/^5:(\d+)\+::([\s\S]+)$/);
        if (!match) return;
        const ackId = Number(match[1]);
        const evt = JSON.parse(match[2]);
        const args = Array.isArray(evt.args) ? evt.args : [];

        if (evt.name === 'joinDoc') {
          const docId = args[0];
          const doc = docs.get(docId);
          if (!doc) {
            socket.write(encodeWsTextFrame(`6:::${ackId}+${JSON.stringify(['doc_not_found'])}`));
            return;
          }
          // Return Latin-1 stuffed UTF-8 lines on methodDocId to verify decoding end-to-end!
          const lines = doc.text.split('\n').map((l) =>
            docId === methodDocId ? Buffer.from(l, 'utf8').toString('latin1') : l
          );
          socket.write(encodeWsTextFrame(`6:::${ackId}+${JSON.stringify([null, lines, doc.version])}`));
          return;
        }

        if (evt.name === 'applyOtUpdate') {
          const docId = args[0];
          const body = args[1] || {};
          const doc = docs.get(docId);
          if (!doc) {
            socket.write(encodeWsTextFrame(`6:::${ackId}+${JSON.stringify(['doc_not_found'])}`));
            return;
          }
          if (Number(body.v) !== doc.version) {
            socket.write(
              encodeWsTextFrame(`6:::${ackId}+${JSON.stringify([`version_mismatch:${body.v}!=${doc.version}`])}`)
            );
            return;
          }
          doc.text = applyOp(doc.text, body.op || []);
          doc.version += 1;
          state.receivedOtUpdates.push({ docId, op: body.op, v: body.v, textAfter: doc.text });
          // Broadcast echo just like ShareJS/Overleaf does before/around ack.
          broadcastEvent('otUpdateApplied', [
            { doc: docId, v: body.v, meta: body.meta || { source: 'mock-pub-1' } },
          ]);
          socket.write(encodeWsTextFrame(`6:::${ackId}+${JSON.stringify([null])}`));
        }
      },
    });

    // Overleaf auto-push sequence: connect (`1::`), connectionAccepted, joinProjectResponse
    socket.write(encodeWsTextFrame('1::'));
    sendSocketEvent(socket, 'connectionAccepted', ['mock-pub-1']);
    sendSocketEvent(socket, 'joinProjectResponse', [
      {
        publicId: 'mock-pub-1',
        permissionsLevel: 'owner',
        project: {
          _id: projectId,
          name: 'Mock Quantum Paper',
          rootDoc_id: mainDocId,
          rootFolder: [rootFolder],
        },
      },
    ]);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    projectId,
    mainDocId,
    introDocId,
    methodDocId,
    expectedCookie,
    docs,
    state,
    pushRemoteOtUpdate(docId, op) {
      const doc = docs.get(docId);
      assert.ok(doc, `Unknown remote docId ${docId}`);
      const sentV = doc.version;
      doc.text = applyOp(doc.text, op);
      doc.version += 1;
      broadcastEvent('otUpdateApplied', [
        { doc: docId, op, v: sentV, meta: { source: 'remote-coauthor-xyz' } },
      ]);
      return doc.text;
    },
    close() {
      for (const s of state.sockets) {
        try { s.destroy(); } catch {}
      }
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function runUnitTests() {
  console.log('[1/4] Running unit tests (OT, UTF-8 decoding, SyncTeX, LaTeX logs)...');

  // OT + CRLF + Chinese + Surrogate pairs + multi-hunk
  const a0 = normalizeNewlines('第一行\r\nHello 🚀 world!\r\n第三行\r\n');
  const a1 = '第一行（已修订）\nHello 𝛼 world! 深度学习实验。\n第三行结尾\n';
  const opA = diffToOp(a0, a1);
  assert.equal(applyOp(a0, opA), a1, 'OT round-trip failed for Chinese + CRLF + surrogates');

  // Random diamond concurrency check
  const base = 'Alpha\nBeta 🚀 Gamma\n深度学习\nOmega';
  const left = 'Alpha 1\nBeta 🚀 Delta\n深度学习\nOmega';
  const right = 'Alpha\nBeta 🚀 Gamma\n深度强化学习\nOmega 2';
  const opL = diffToOp(base, left);
  const opR = diffToOp(base, right);
  const [opL2, opR2] = transformX(opL, opR, 'left');
  assert.equal(
    applyOp(applyOp(base, opR), opL2),
    applyOp(applyOp(base, opL), opR2),
    'OT transformX diamond convergence failed'
  );

  // decodeOverleafLine: Latin-1 stuffed UTF-8 vs native Unicode
  const nativeZh = '深度学习实验 🚀 method';
  const latinStuffed = Buffer.from('深度学习实验', 'utf8').toString('latin1');
  assert.equal(decodeOverleafLine(latinStuffed), '深度学习实验');
  assert.equal(decodeOverleafLine(nativeZh), nativeZh);

  // SyncTeX forward & inverse round-trip
  const synctexIdx = parseSynctexGz(buildSampleSynctexGz());
  const fwd = forwardSync(synctexIdx, 'sections/method.tex', 14);
  assert.ok(fwd, 'forwardSync returned null');
  assert.equal(fwd.page, 1);
  assert.ok(Math.abs(fwd.xPt - 120) < 1 && Math.abs(fwd.yTopPt - 240) < 20);
  const inv = inverseSync(synctexIdx, 1, 130, fwd.yTopPt);
  assert.ok(inv, 'inverseSync returned null');
  assert.equal(inv.file, 'sections/method.tex');
  assert.equal(inv.line, 14);

  // SyncTeX boundary checks: preamble line (>5 lines away), inter-line click not captured by outer vbox, and fileFilter
  const fwdPreamble = forwardSync(synctexIdx, 'main.tex', 1);
  assert.ok(fwdPreamble, 'forwardSync should fall back to nearest record on preamble lines');
  assert.equal(fwdPreamble.page, 1);
  assert.equal(fwdPreamble.matchedLine, 50);

  const invBlankGap = inverseSync(synctexIdx, 1, 130, 150);
  assert.ok(invBlankGap, 'inverseSync returned null in inter-line gap');
  assert.notEqual(invBlankGap.line, 999, 'inverseSync captured outer page vbox instead of nearest line');

  const invBblFiltered = inverseSync(synctexIdx, 1, 150, 392, {
    fileFilter: (f) => f === 'main.tex' || f === 'sections/method.tex',
  });
  assert.ok(invBblFiltered, 'inverseSync returned null with fileFilter');
  assert.notEqual(invBblFiltered.file, 'output.bbl', 'inverseSync failed to filter out output.bbl');
  assert.notEqual(invBblFiltered.line, 999);

  // LaTeX log parser
  const parsedLog = parseLatexLog(
    [
      '(./sections/intro.tex',
      '! Undefined control sequence.',
      'l.88 \\badmacro',
      "LaTeX Warning: Citation 'doe2025' on page 1 undefined on input line 90.",
      'Overfull \\hbox (12.34pt too wide) in paragraph at lines 40--42',
    ].join('\n')
  );
  assert.equal(parsedLog.summary.errorCount, 1);
  assert.equal(parsedLog.errors[0].line, 88);
  assert.match(parsedLog.errors[0].file || '', /sections\/intro\.tex/);
  assert.ok(parsedLog.summary.warningCount >= 1);
  assert.ok(parsedLog.summary.badboxCount >= 1);
  assert.equal(parsedLog.summary.ok, false);

  // Classic-script & Aux Pane CSP guard assertions
  const testDir = dirname(fileURLToPath(import.meta.url));
  const indexHtml = readFileSync(join(testDir, '..', 'index.html'), 'utf8');
  const appJsSource = readFileSync(join(testDir, '..', 'app.js'), 'utf8');
  assert.ok(indexHtml.includes('<script src="/app.js" defer></script>'));
  assert.ok(indexHtml.includes("script-src 'self' blob:"));
  assert.ok(indexHtml.includes("object-src 'none'"));
  assert.ok(indexHtml.includes("base-uri 'none'"));
  assert.equal(indexHtml.includes('type="module"'), false);
  new Script(appJsSource, { filename: 'app.js' });

  const authSource = readFileSync(join(testDir, '..', 'lib', 'auth.mjs'), 'utf8');
  assert.equal(/msedge/i.test(authSource), false, 'auth.mjs must not reference msedge');
  const chromeBin = findChromeBinary();
  if (chromeBin) {
    assert.ok(chromeBin.toLowerCase().endsWith('chrome.exe'), `Expected chrome.exe, got ${chromeBin}`);
  }
}

async function runIntegrationTests() {
  console.log('[2/4] Starting Mock Overleaf HTTP + Socket.IO server & SyncManager...');
  const mock = await createMockOverleafServer();
  const sync = new SyncManager();
  let ipcServer = null;

  try {
    // 0a. Anonymous / unauthenticated cookie must be rejected without poisoning session state
    await assert.rejects(
      () =>
        sync.setCookieAuth({
          cookieInput: 'overleaf_session2=anon-unauthenticated-session',
          baseUrl: mock.baseUrl,
        }),
      /登录|Cookie/
    );
    assert.equal(sync.getAuthStatus().authenticated, false);
    assert.equal(existsSync(join(TEST_STATE_DIR, 'session.json')), false);

    // 0b. Real Chrome headless popup flow: stays open on /login despite anonymous overleaf_session2 cookie,
    //     completes only after navigating to authenticated /project with valid cookie + metadata.
    const chromeBin = findChromeBinary();
    if (chromeBin) {
      const popupStart = await sync.startPopupAuth({ baseUrl: mock.baseUrl, headless: true });
      assert.equal(popupStart.started, true);
      assert.ok(popupStart.port > 0);

      // Wait until Chrome finishes loading /login and poll() has run at least twice
      const loginTarget = await waitFor(async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${popupStart.port}/json`);
          if (!r.ok) return null;
          const list = await r.json();
          return Array.isArray(list)
            ? list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && String(t.url).includes('/login'))
            : null;
        } catch {
          return null;
        }
      }, { timeoutMs: 8000, label: 'Chrome popup landing on /login' });
      assert.ok(loginTarget);

      await delay(1800);
      assert.equal(sync.getAuthStatus().loginPopupActive, true, 'Chrome popup closed prematurely on /login');
      assert.equal(sync.getAuthStatus().authenticated, false, 'Anonymous cookie falsely marked authenticated');

      // Inject authenticated session cookie into Chrome & navigate to /project (simulating user sign-in)
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(loginTarget.webSocketDebuggerUrl);
        const timer = setTimeout(() => {
          try { ws.close(); } catch {}
          reject(new Error('CDP login simulation timeout'));
        }, 5000);
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Network.setCookie',
              params: {
                name: 'overleaf_session2',
                value: mock.expectedCookie,
                url: mock.baseUrl,
                path: '/',
              },
            })
          );
        };
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) {
            ws.send(
              JSON.stringify({
                id: 2,
                method: 'Page.navigate',
                params: { url: `${mock.baseUrl}/project` },
              })
            );
          } else if (msg.id === 2) {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve();
          }
        };
        ws.onerror = (err) => {
          clearTimeout(timer);
          reject(new Error(err?.message || 'CDP ws error'));
        };
      });

      await waitFor(
        () => !sync.getAuthStatus().loginPopupActive && sync.getAuthStatus().authenticated,
        { timeoutMs: 8000, label: 'Chrome popup 3-gate login completion' }
      );
      assert.equal(sync.getAuthStatus().userEmail, 'researcher@example.com');
      assert.equal((await sync.listProjects()).length, 1);

      sync.logout();
      await delay(300);
      assert.equal(sync.getAuthStatus().authenticated, false);
    }

    // 1. Cookie auth & project listing
    const authRes = await sync.setCookieAuth({
      cookieInput: `overleaf_session2=${mock.expectedCookie}`,
      baseUrl: mock.baseUrl,
    });
    assert.equal(authRes.authenticated, true);
    assert.equal(authRes.userEmail, 'researcher@example.com');
    assert.equal(authRes.projects.length, 1);

    // 2. Connect project & pull initial mirror
    const runtime = await sync.connectProject({
      projectId: mock.projectId,
      conversationId: 'conv-selftest',
      autoInitialCompile: false,
    });
    assert.equal(runtime.rootDocPath, 'main.tex');
    assert.equal(
      readFileSync(join(runtime.mirrorDir, 'sections', 'method.tex'), 'utf8'),
      '\\section{Method}\n% Chinese UTF-8 check\n深度学习实验方法。',
      'Latin-1 stuffed UTF-8 doc failed to pull cleanly to disk'
    );
    assert.ok(existsSync(join(runtime.mirrorDir, 'figures', 'arch.png')));

    // Enable fast 500ms debounce auto-compile for testing real-time edit -> OT -> compile
    sync.updateSettings({ projectId: mock.projectId, autoCompile: true, debounceMs: 500 });

    // 3. Initial cloud compile & SyncTeX check
    const compile1 = await sync.runCloudCompile(mock.projectId, { reason: 'selftest' });
    assert.equal(compile1.ok, true);
    assert.equal(compile1.hasPdf, true);
    assert.equal(compile1.hasSynctex, true);
    const compileBeforeEdit = mock.state.compileCount;

    const fwdRes = await sync.forwardSync(mock.projectId, 'sections/method.tex', 14);
    assert.equal(fwdRes?.page, 1);
    const invRes = await sync.inverseSync(mock.projectId, 1, 130, fwdRes.yTopPt);
    assert.equal(invRes?.file, 'sections/method.tex');

    // 4. Modify sections/intro.tex directly on disk -> assert OT + auto-compile
    console.log('[3/4] Testing live disk edit -> OT -> auto-compile -> remote merge -> guardrail -> undo...');
    const introAbs = join(runtime.mirrorDir, 'sections', 'intro.tex');
    const diskEditedText = '\\section{Introduction}\nHello Overleaf local agent edit!';
    const otBeforeDiskEdit = mock.state.receivedOtUpdates.length;
    writeFileSync(introAbs, diskEditedText, 'utf8');

    await waitFor(
      () => mock.docs.get(mock.introDocId).text === diskEditedText,
      { label: 'disk edit synced via OT to mock Overleaf' }
    );
    assert.ok(mock.state.receivedOtUpdates.length > otBeforeDiskEdit);

    await waitFor(
      () => mock.state.compileCount > compileBeforeEdit && !runtime.compiling,
      { timeoutMs: 4000, label: 'auto-compile after disk edit' }
    );

    // 5. Remote co-author OT edit -> disk updates without echo loop
    const otCountBeforeRemote = mock.state.receivedOtUpdates.length;
    const remoteCurrent = mock.docs.get(mock.introDocId).text;
    const remoteTarget = `${remoteCurrent}\nCollaborator added methodology preview.`;
    mock.pushRemoteOtUpdate(mock.introDocId, diffToOp(remoteCurrent, remoteTarget));

    await waitFor(
      () => readFileSync(introAbs, 'utf8') === remoteTarget,
      { label: 'remote co-author OT edit written to disk' }
    );
    await delay(250);
    assert.equal(
      mock.state.receivedOtUpdates.length,
      otCountBeforeRemote,
      'Remote OT edit triggered an unexpected echo-loop applyOtUpdate!'
    );

    // 6. Destructive delete guardrail on root document `main.tex`
    const mainAbs = join(runtime.mirrorDir, 'main.tex');
    unlinkSync(mainAbs);
    await waitFor(
      () => existsSync(mainAbs) && Boolean(runtime.guardrailAlert),
      { timeoutMs: 3000, label: 'delete guardrail auto-restore of main.tex' }
    );
    assert.match(runtime.guardrailAlert.message, /main\.tex/);
    sync.dismissGuardrail(mock.projectId);
    assert.equal(runtime.guardrailAlert, null);

    // 7. Single-step Undo (panel edit -> undoLastBatch reverts disk & remote)
    // Wait briefly beyond ECHO_SUPPRESS_MS or perform explicit UI edit so undo batch is clean
    const textBeforeUndoableEdit = remoteTarget;
    const textAfterUiEdit = `${textBeforeUndoableEdit}\nTemporary paragraph to undo.`;
    await sync.saveDocFromUi(mock.projectId, 'sections/intro.tex', textAfterUiEdit);
    assert.equal(mock.docs.get(mock.introDocId).text, textAfterUiEdit);

    const uiBeforeUndo = sync.getUiState({ conversationId: 'conv-selftest' });
    assert.equal(uiBeforeUndo.activeProject.undoAvailable, true);

    const undoRes = await sync.undoLastBatch(mock.projectId);
    assert.equal(undoRes.undone, true);
    assert.equal(readFileSync(introAbs, 'utf8'), textBeforeUndoableEdit);
    assert.equal(mock.docs.get(mock.introDocId).text, textBeforeUndoableEdit);
    const uiAfterUndo = sync.getUiState({ conversationId: 'conv-selftest' });
    assert.equal(uiAfterUndo.activeProject.undoAvailable, false);

    // 7b. Compile failure (`status: 'failure'` + missing output.pdf 404) preserves log diagnostics and recovers
    await sync.saveDocFromUi(mock.projectId, 'sections/intro.tex', `${textBeforeUndoableEdit}\n\\badmacro`);
    const compileFail = await sync.runCloudCompile(mock.projectId, { reason: 'badmacro-test' });
    assert.equal(compileFail.ok, false);
    assert.equal(compileFail.status, 'failure');
    assert.equal(compileFail.diagnostics.summary.errorCount, 1);
    assert.equal(compileFail.diagnostics.errors[0].line, 88);
    assert.equal(sync.getUiState({ conversationId: 'conv-selftest' }).activeProject.lastError, '');

    await sync.undoLastBatch(mock.projectId);
    const compileRecovered = await sync.runCloudCompile(mock.projectId, { reason: 'recover-test' });
    assert.equal(compileRecovered.ok, true);

    // 8. Register routes & Sidecar/IPC/MCP server integration
    console.log('[4/4] Testing Sidecar HTTP routes, authenticated IPC bridge & MCP tools...');
    const routes = { pages: new Map(), apis: new Map() };
    const mockApp = {
      page(path, handler) { routes.pages.set(path, handler); },
      api(path, handler, method = 'POST') { routes.apis.set(`${method.toUpperCase()} ${path}`, handler); },
    };
    registerRoutes(mockApp, sync, { defaultConversationId: 'conv-selftest' });
    assert.ok(routes.pages.has('/'));
    assert.ok(routes.pages.has('/app.js'));
    assert.ok(routes.apis.has('GET /api/state'));
    assert.ok(routes.apis.has('POST /api/compile'));
    assert.ok(routes.apis.has('POST /api/compile/target'));

    const targetRes = await routes.apis.get('POST /api/compile/target')({ path: 'sections/intro.tex' });
    assert.equal(targetRes.compileTargetPath, 'sections/intro.tex');
    await routes.apis.get('POST /api/compile')({});
    assert.equal(mock.state.lastRootDocId, 'doc-intro-2');
    assert.equal(mock.state.lastCompiledRootDocId, 'doc-intro-2');
    assert.equal(mock.state.lastCompileIncremental, false);
    // Switch back to main.tex for subsequent tests
    await routes.apis.get('POST /api/compile/target')({ path: 'main.tex' });

    const stateRouteRes = routes.apis.get('GET /api/state')({});
    assert.equal(stateRouteRes.activeProject.id, mock.projectId);
    const pdfRouteRes = routes.apis.get('GET /api/pdf')({});
    assert.equal(pdfRouteRes.status, 200);
    const docRouteRes = await routes.apis.get('GET /api/doc')({ path: 'main.tex' });
    assert.match(docRouteRes.content, /\\documentclass/);

    const startedIpc = await startIpcBridge(sync, { writeDaemonFile: true });
    ipcServer = startedIpc.ipcServer;
    const { port, token } = startedIpc.info;

    const unauthHealth = await fetch(`http://127.0.0.1:${port}/ipc/health`);
    assert.equal(unauthHealth.status, 401);

    const authHealth = await fetch(`http://127.0.0.1:${port}/ipc/health`, {
      headers: { 'x-overleaf-ipc-token': token },
    });
    assert.equal(authHealth.status, 200);
    const healthJson = await authHealth.json();
    assert.equal(healthJson.ok, true);

    // Also test direct dispatch helper error check
    await assert.rejects(() => dispatchIpcAction(sync, 'nonexistent_op', {}), /未知的 IPC 动作/);

    // Test MCP JSON-RPC protocol & tool calls routed through live authenticated IPC
    const initResp = await handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.equal(initResp.result.serverInfo.name, 'overleaf-live');

    const listResp = await handleJsonRpcRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const toolNames = listResp.result.tools.map((t) => t.name);
    assert.deepEqual(toolNames, [
      'overleaf_status',
      'overleaf_list_projects',
      'overleaf_connect_project',
      'overleaf_compile',
      'overleaf_focus',
      'overleaf_file_ops',
      'overleaf_undo',
    ]);

    const statusCall = await handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'overleaf_status', arguments: { conversation_id: 'conv-selftest' } },
    });
    assert.equal(statusCall.result.isError, false);
    const statusPayload = JSON.parse(statusCall.result.content[0].text);
    assert.equal(statusPayload.authenticated, true);
    assert.equal(statusPayload.activeProject.id, mock.projectId);

    const focusCall = await handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'overleaf_focus',
        arguments: { conversation_id: 'conv-selftest', file: 'sections/method.tex', line: 14 },
      },
    });
    assert.equal(focusCall.result.isError, false);
    assert.equal(JSON.parse(focusCall.result.content[0].text).highlight.page, 1);

    const compileCall = await handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'overleaf_compile', arguments: { conversation_id: 'conv-selftest' } },
    });
    assert.equal(compileCall.result.isError, false);
    assert.equal(JSON.parse(compileCall.result.content[0].text).ok, true);

    const createDocCall = await handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'overleaf_file_ops',
        arguments: {
          conversation_id: 'conv-selftest',
          action: 'create_doc',
          parent_path: 'sections',
          name: 'appendix.tex',
        },
      },
    });
    assert.equal(createDocCall.result.isError, false);
    assert.ok(existsSync(join(runtime.mirrorDir, 'sections', 'appendix.tex')));

    const deleteDocCall = await handleJsonRpcRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'overleaf_file_ops',
        arguments: {
          conversation_id: 'conv-selftest',
          action: 'delete',
          path: 'sections/appendix.tex',
          confirm_delete: true,
        },
      },
    });
    assert.equal(deleteDocCall.result.isError, false);
    assert.equal(existsSync(join(runtime.mirrorDir, 'sections', 'appendix.tex')), false);

    // Spawn mcp_server.mjs via plain node (WITHOUT sidecar_sdk register_loader.js!)
    // to prove Antigravity's stdio MCP host can launch it cleanly and query live IPC.
    const testDir = dirname(fileURLToPath(import.meta.url));
    const mcpServerPath = join(testDir, '..', '..', '..', 'mcp', 'mcp_server.mjs');
    const childEnv = { ...process.env };
    delete childEnv.OVERLEAF_MCP_IMPORT_ONLY;
    delete childEnv.NODE_OPTIONS;

    const childResponses = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [mcpServerPath], {
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdoutBuf = '';
      let stderrBuf = '';
      const parsed = [];
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error(`Plain stdio MCP child timeout. stderr=${stderrBuf} stdout=${stdoutBuf}`));
      }, 6000);

      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf8');
      });
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line) parsed.push(JSON.parse(line));
        }
        if (parsed.length >= 3) {
          clearTimeout(timer);
          child.stdin.end();
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (stderrBuf.trim()) {
          reject(new Error(`Unexpected stderr from plain stdio MCP child: ${stderrBuf}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`Plain stdio MCP child exited with code ${code}`));
          return;
        }
        resolve(parsed);
      });

      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list' })}\n`);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 103,
          method: 'tools/call',
          params: { name: 'overleaf_status', arguments: { conversation_id: 'conv-selftest' } },
        })}\n`
      );
    });

    assert.equal(childResponses[0].id, 101);
    assert.equal(childResponses[0].result.serverInfo.name, 'overleaf-live');
    assert.equal(childResponses[1].id, 102);
    assert.equal(childResponses[1].result.tools.length, 7);
    assert.equal(childResponses[2].id, 103);
    assert.equal(childResponses[2].result.isError, false);
    assert.equal(JSON.parse(childResponses[2].result.content[0].text).activeProject.id, mock.projectId);

    // 9. Sidecar restart auto-reconnect check using persisted session.json & config.json
    // Exercises cold 429 retry, persistent 429 existing-mirror fallback, concurrent connect-vs-compile race,
    // and warm-restart zero-download fileIndex cache.
    sync.closeAll();
    const clearPersistedFileIndex = () => {
      const cfg = loadConfig();
      if (cfg.projects?.[mock.projectId]) {
        cfg.projects[mock.projectId].fileIndex = {};
        saveConfig(cfg);
      }
    };

    clearPersistedFileIndex();
    const downloadAttemptsBefore = mock.state.fileDownloadAttempts;
    mock.state.failFileDownloadsMode = 'transient-429-once';
    const syncRestarted = new SyncManager();
    try {
      const initialRestartUi = syncRestarted.getUiState({ conversationId: 'conv-selftest' });
      assert.equal(initialRestartUi.reconnectingProjectId, mock.projectId);
      const reconnectedUi = await waitFor(() => {
        const snap = syncRestarted.getUiState({ conversationId: 'conv-selftest' });
        return snap.activeProject?.compileResult?.ok ? snap : null;
      }, { timeoutMs: 8000, label: 'auto-reconnect and compile after simulated sidecar restart' });
      assert.equal(reconnectedUi.activeProject.id, mock.projectId);
      assert.equal(reconnectedUi.activeProject.undoAvailable, false);
      assert.ok(
        mock.state.fileDownloadAttempts >= downloadAttemptsBefore + 2,
        'downloadFile should retry after transient HTTP 429'
      );
    } finally {
      syncRestarted.closeAll();
    }

    clearPersistedFileIndex();
    const uploadsBefore = mock.state.uploadCount;
    mock.state.failFileDownloadsMode = 'always-429';
    const syncRestarted2 = new SyncManager();
    try {
      syncRestarted2.getUiState({ conversationId: 'conv-selftest' });
      await waitFor(() => {
        const snap = syncRestarted2.getUiState({ conversationId: 'conv-selftest' });
        return snap.activeProject?.compileResult?.ok ? snap : null;
      }, { timeoutMs: 8000, label: 'auto-reconnect with persistent 429 existing-mirror fallback' });
      await syncRestarted2.runCloudCompile(mock.projectId, { reason: 'manual' });
      const snapAfterCompile = syncRestarted2.getUiState({ conversationId: 'conv-selftest' });
      assert.equal(mock.state.uploadCount, uploadsBefore, 'Existing mirror attachments must not be re-uploaded on 429');
      assert.equal(snapAfterCompile.activeProject.undoAvailable, false);
      assert.equal(snapAfterCompile.activeProject.lastError, '');
    } finally {
      mock.state.failFileDownloadsMode = 'none';
      syncRestarted2.closeAll();
    }

    clearPersistedFileIndex();
    const uploadsBeforeRace = mock.state.uploadCount;
    mock.state.fileDownloadDelayMs = 250;
    const syncRace = new SyncManager();
    try {
      const startRaceUi = syncRace.getUiState({ conversationId: 'conv-selftest' });
      assert.equal(startRaceUi.reconnectingProjectId, mock.projectId);
      await delay(20);
      const raceCompile = await syncRace.runCloudCompile(mock.projectId, { reason: 'agent' });
      assert.equal(raceCompile.ok, true);
      const snapAfterRace = syncRace.getUiState({ conversationId: 'conv-selftest' });
      assert.equal(
        mock.state.uploadCount,
        uploadsBeforeRace,
        'Concurrent compile during #pullInitialMirror must await initial pull without spurious re-uploads'
      );
      assert.equal(snapAfterRace.activeProject.undoAvailable, false);
    } finally {
      mock.state.fileDownloadDelayMs = 0;
      syncRace.closeAll();
    }

    const attemptsBeforeWarm = mock.state.fileDownloadAttempts;
    const syncWarm = new SyncManager();
    try {
      syncWarm.getUiState({ conversationId: 'conv-selftest' });
      const warmUi = await waitFor(() => {
        const snap = syncWarm.getUiState({ conversationId: 'conv-selftest' });
        return snap.activeProject?.compileResult?.ok ? snap : null;
      }, { timeoutMs: 8000, label: 'warm reconnect using persisted fileIndex cache' });
      assert.equal(warmUi.activeProject.undoAvailable, false);
      assert.equal(
        mock.state.fileDownloadAttempts,
        attemptsBeforeWarm,
        'Warm reconnect should skip re-downloading unchanged binaries when fileIndex matches'
      );
    } finally {
      syncWarm.closeAll();
    }
  } finally {
    sync.closeAll();
    if (ipcServer) await new Promise((r) => ipcServer.close(r));
    await mock.close();
  }
}

try {
  await runUnitTests();
  await runIntegrationTests();
  console.log('ALL TESTS PASSED');
} finally {
  rmSync(TEST_ROOT, { recursive: true, force: true });
}
