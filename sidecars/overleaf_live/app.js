/**
 * Overleaf Live Workbench Frontend (Antigravity Aux Pane).
 *
 * Features:
 *  - ETag-polled live state sync with automatic active conversation project tracking
 *  - Collapsible hierarchical File Tree + create doc / folder / binary upload / guarded delete
 *  - Editable LaTeX Source with synchronized syntax backdrop, line numbers, Agent edit flash,
 *    and 350ms debounced bidirectional sync to local mirror + Overleaf OT
 *  - Live Unified Diff vs single-step pre-edit snapshot + 1-click Undo
 *  - Vendored local PDF.js 4.10.38 HiDPI canvas renderer with scroll-preserving hot swap
 *  - Bidirectional SyncTeX (Source line / Alt+Click -> PDF highlight; PDF dblclick -> Source line)
 *  - Structured clickable LaTeX compile diagnostics + 1-click "Send errors to Agent"
 *  - Dual-channel Overleaf Auth modal (Isolated Browser Popup & Cookie Import)
 */
(() => {
  'use strict';

  const POLL_ACTIVE_MS = 1200;
  const POLL_HIDDEN_MS = 4000;
  const DOC_SAVE_DEBOUNCE_MS = 350;

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const pageToken = String(params.get('token') || '').trim();

const state = {
  conversationId: String(window.sidecar?.conversationId || params.get('conversationId') || '').trim(),
  etag: '',
  snap: null,
  activeProjectId: '',
  activeFilePath: '',
  activeDocVersion: -1,
  activeDocData: null,
  mode: 'split', // split | source | diff | pdf | logs
  treeOpen: true,
  collapsedFolders: new Set(),
  selectedFolderPath: '',
  editorDirty: false,
  saveTimer: 0,
  focusedLine: null,
  errorLines: new Set(),
  lastFocusSeq: 0,
  lastRenderedPdfEtag: '',
  pdfDoc: null,
  pdfZoomMode: 'fit', // 'fit' | 'manual'
  pdfScale: 1.0,
  pageRenderScale: new Map(), // pageNum -> scale
  pdfRendering: false,
  pendingPdfRender: false,
  highlightTimer: 0,
  pendingHighlight: null,
  pollTimer: 0,
  pollInFlight: false,
  lastAlertKey: '',
  dismissedAlertId: '',
  pendingDeleteTarget: null,
  pendingEntityAction: null,
};

// ---------- Sidecar API helpers ----------
function buildApiPath(path, query = {}) {
  const qIdx = path.indexOf('?');
  const pathname = qIdx >= 0 ? path.slice(0, qIdx) : path;
  const sp = new URLSearchParams(qIdx >= 0 ? path.slice(qIdx + 1) : '');
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') {
      sp.set(k, String(v));
    }
  }
  if (pageToken && !sp.has('token')) {
    sp.set('token', pageToken);
  }
  const qs = sp.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function sFetch(path, options = {}) {
  const authedPath = buildApiPath(path);
  if (window.sidecar?.fetch) {
    return window.sidecar.fetch(authedPath, options);
  }
  const headers = new Headers(options.headers || {});
  if (pageToken && !headers.has('X-Sidecar-Token')) {
    headers.set('X-Sidecar-Token', pageToken);
  }
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(authedPath, { ...options, headers });
}

async function apiGet(path, query = {}) {
  const url = buildApiPath(path, {
    conversationId: query.conversationId || state.conversationId,
    ...query,
  });
  const res = await sFetch(url, { method: 'GET' });
  if (!res.ok) {
    const err = await safeReadError(res);
    throw new Error(err);
  }
  return res.json();
}

async function apiPost(path, body = {}) {
  const payload = {
    conversationId: state.conversationId,
    ...body,
  };
  const res = await sFetch(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await safeReadError(res);
    throw new Error(err);
  }
  return res.json();
}

async function safeReadError(res) {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      return json?.error || text || `HTTP ${res.status}`;
    } catch {
      return text || `HTTP ${res.status}`;
    }
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ---------- UI Helpers ----------
function showAlert(msg, key = '') {
  if (!msg) return;
  if (key && state.dismissedAlertId === key) return;
  state.lastAlertKey = key;
  $('alert-message').textContent = msg;
  $('alert-banner').classList.remove('hidden');
}

function hideAlert() {
  if (state.lastAlertKey) {
    state.dismissedAlertId = state.lastAlertKey;
  }
  $('alert-banner').classList.add('hidden');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- Mode & Layout Controls ----------
function setMode(nextMode) {
  state.mode = nextMode;
  const split = $('split-container');
  split.dataset.mode = nextMode;

  for (const btn of document.querySelectorAll('.mode-btn')) {
    const active = btn.dataset.mode === nextMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  const showSource = nextMode === 'split' || nextMode === 'source';
  const showPdf = nextMode === 'split' || nextMode === 'pdf';
  const showDiff = nextMode === 'diff';
  const showLogs = nextMode === 'logs';

  $('source-pane').classList.toggle('hidden', !showSource);
  $('pdf-pane').classList.toggle('hidden', !showPdf);
  $('diff-pane').classList.toggle('hidden', !showDiff);
  $('logs-pane').classList.toggle('hidden', !showLogs);

  if (showPdf && state.pdfDoc) {
    schedulePdfRender(false);
  }
  if (showDiff) {
    renderDiffPane();
  }
  if (showLogs) {
    renderLogsPane();
  }
}

function setTreeOpen(open) {
  state.treeOpen = open;
  const drawer = $('file-tree-drawer');
  drawer.dataset.open = open ? 'true' : 'false';
  drawer.classList.toggle('collapsed', !open);
  $('tree-toggle-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
}

// ---------- Syntax Highlighting & Editor Sync ----------
function tokenizeLatexLine(rawLine) {
  if (!rawLine) return '&nbsp;';

  // Split unescaped comment `% ...`
  let commentIdx = -1;
  for (let i = 0; i < rawLine.length; i++) {
    if (rawLine[i] === '%' && (i === 0 || rawLine[i - 1] !== '\\')) {
      commentIdx = i;
      break;
    }
  }
  const codePart = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
  const commentPart = commentIdx >= 0 ? rawLine.slice(commentIdx) : '';

  const tokenRe =
    /(\\(?:begin|end)\{[^}]*\})|(\$\$?[^$]*\$\$?)|(\\[A-Za-z@]+\*?)|(\\[\\{}%$&#_^~])|([{}[\]])/g;
  let out = '';
  let last = 0;
  let m;

  while ((m = tokenRe.exec(codePart)) !== null) {
    if (m.index > last) {
      out += escapeHtml(codePart.slice(last, m.index));
    }
    if (m[1]) {
      out += `<span class="tok-env">${escapeHtml(m[1])}</span>`;
    } else if (m[2]) {
      out += `<span class="tok-math">${escapeHtml(m[2])}</span>`;
    } else if (m[3] || m[4]) {
      out += `<span class="tok-cmd">${escapeHtml(m[3] || m[4])}</span>`;
    } else if (m[5]) {
      out += `<span class="tok-brace">${escapeHtml(m[5])}</span>`;
    }
    last = tokenRe.lastIndex;
  }

  if (last < codePart.length) {
    out += escapeHtml(codePart.slice(last));
  }
  if (commentPart) {
    out += `<span class="tok-comment">${escapeHtml(commentPart)}</span>`;
  }
  return out || '&nbsp;';
}

function renderEditorDecoration() {
  const editor = $('source-editor');
  const backdrop = $('editor-backdrop');
  const gutter = $('editor-gutter');
  const lines = String(editor.value || '').split('\n');

  const lineCount = lines.length;
  const gutterFragments = new Array(lineCount);
  const codeFragments = new Array(lineCount);

  for (let i = 0; i < lineCount; i++) {
    const lineNum = i + 1;
    const isFocused = state.focusedLine === lineNum;
    const isError = state.errorLines.has(lineNum);
    const cls = isError ? ' error' : isFocused ? ' active' : '';
    gutterFragments[i] = `<span class="gutter-line${cls}">${lineNum}</span>`;
    codeFragments[i] = `<span class="editor-line${cls}">${tokenizeLatexLine(lines[i])}</span>`;
  }

  gutter.innerHTML = gutterFragments.join('');
  backdrop.innerHTML = codeFragments.join('');
  syncEditorScroll();
}

function syncEditorScroll() {
  const editor = $('source-editor');
  $('editor-backdrop').scrollTop = editor.scrollTop;
  $('editor-backdrop').scrollLeft = editor.scrollLeft;
  $('editor-gutter').scrollTop = editor.scrollTop;
}

function getCursorLine(textarea) {
  const pos = textarea.selectionStart || 0;
  return textarea.value.slice(0, pos).split('\n').length;
}

function scrollEditorToLine(lineNum, { focusEditor = false } = {}) {
  const editor = $('source-editor');
  const backdrop = $('editor-backdrop');
  const lines = editor.value.split('\n');
  const target = Math.max(1, Math.min(lines.length, Math.round(lineNum)));
  state.focusedLine = target;
  renderEditorDecoration();

  let offset = 0;
  for (let i = 0; i < target - 1; i++) {
    offset += lines[i].length + 1;
  }
  const firstEl = backdrop.children[0];
  const targetEl = backdrop.children[target - 1];
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 19.375;
  const lineTop = targetEl && firstEl
    ? targetEl.offsetTop - firstEl.offsetTop
    : (target - 1) * lineHeight;
  const targetTop = Math.max(0, lineTop - editor.clientHeight * 0.35);
  editor.scrollTop = targetTop;
  syncEditorScroll();
  if (focusEditor) {
    editor.focus();
    editor.setSelectionRange(offset, offset + (lines[target - 1]?.length || 0));
  }
}

async function renderBinaryPdfFigure(preview, relPath, base64, size) {
  try {
    const pdfjsLib = await ensurePdfJs();
    const binStr = atob(base64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    const figDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    try {
      if (state.activeFilePath !== relPath) return;
      const page = await figDoc.getPage(1);
      const baseVp = page.getViewport({ scale: 1.0 });
      const maxW = Math.max(200, (preview.clientWidth || 360) - 48);
      const scale = Math.min(2.0, maxW / baseVp.width);
      const viewport = page.getViewport({ scale });
      const dpr = Math.min(2, window.devicePixelRatio || 1);

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (state.activeFilePath !== relPath) return;

      const meta = document.createElement('div');
      meta.innerHTML = `<code>${escapeHtml(relPath)}</code> (${figDoc.numPages} 页 · ${formatBytes(size)})`;
      preview.replaceChildren(canvas, meta);
    } finally {
      await figDoc.destroy().catch(() => {});
    }
  } catch {
    if (state.activeFilePath !== relPath) return;
    preview.innerHTML = `<div><code>${escapeHtml(relPath)}</code></div><div>application/pdf · ${formatBytes(size)}</div>`;
  }
}

// ---------- File Loading & Saving ----------
async function openFile(relPath, { jumpLine = null, focusEditor = false } = {}) {
  if (!state.activeProjectId || !relPath) return;

  // Flush unsaved edits on previous doc before switching
  if (state.editorDirty && state.activeFilePath && state.activeFilePath !== relPath) {
    await flushEditorSave();
  }

  state.activeFilePath = relPath;
  $('active-file-breadcrumb').textContent = relPath;
  $('active-file-breadcrumb').title = relPath;
  renderFileTree();

  try {
    const doc = await apiGet('/api/doc', { projectId: state.activeProjectId, path: relPath });
    state.activeDocData = doc;
    refreshErrorLinesForActiveFile();

    if (doc.kind === 'doc') {
      $('editor-wrap').classList.remove('hidden');
      $('binary-preview').classList.add('hidden');
      const editor = $('source-editor');
      if (editor.value !== doc.content) {
        editor.value = doc.content;
      }
      state.activeDocVersion = doc.version;
      state.editorDirty = false;
      if (jumpLine) {
        scrollEditorToLine(jumpLine, { focusEditor });
      } else {
        renderEditorDecoration();
      }
    } else {
      $('editor-wrap').classList.add('hidden');
      const preview = $('binary-preview');
      preview.classList.remove('hidden');
      if (doc.dataUrl) {
        preview.innerHTML = `<img src="${doc.dataUrl}" alt="${escapeHtml(doc.path)}"><div><code>${escapeHtml(doc.path)}</code> (${formatBytes(doc.size)})</div>`;
      } else if (doc.pdfBase64) {
        preview.innerHTML = `<div>正在加载 PDF 矢量预览…</div><div><code>${escapeHtml(doc.path)}</code> (${formatBytes(doc.size || 0)})</div>`;
        renderBinaryPdfFigure(preview, doc.path, doc.pdfBase64, doc.size || 0);
      } else {
        preview.innerHTML = `<div><code>${escapeHtml(doc.path)}</code></div><div>${escapeHtml(doc.mimeType || '二进制文件')} · ${formatBytes(doc.size || 0)}</div>`;
      }
    }

    if (state.mode === 'diff') {
      renderDiffPane();
    }
  } catch (err) {
    showAlert(`打开文件失败: ${err.message}`);
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function flushEditorSave() {
  clearTimeout(state.saveTimer);
  if (!state.activeProjectId || !state.activeFilePath || state.activeDocData?.kind !== 'doc') {
    state.editorDirty = false;
    return;
  }
  const targetProjectId = state.activeProjectId;
  const targetPath = state.activeFilePath;
  const content = $('source-editor').value;
  try {
    const res = await apiPost('/api/doc/save', {
      projectId: targetProjectId,
      path: targetPath,
      content,
    });
    if (state.activeProjectId === targetProjectId && state.activeFilePath === targetPath) {
      state.activeDocVersion = res.version ?? state.activeDocVersion;
      if (state.activeDocData) {
        state.activeDocData.content = content;
      }
      if ($('source-editor').value === content) {
        state.editorDirty = false;
      }
    }
  } catch (err) {
    showAlert(`同步源码失败: ${err.message}`);
  }
}

function scheduleEditorSave() {
  state.editorDirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    flushEditorSave();
  }, DOC_SAVE_DEBOUNCE_MS);
}

// ---------- File Tree Rendering ----------
function renderFileTree() {
  const list = $('file-tree-list');
  const proj = state.snap?.activeProject;
  if (!proj || !Array.isArray(proj.tree)) {
    list.innerHTML = '<li class="tree-empty">请先连接一个 Overleaf 项目</li>';
    return;
  }
  if (proj.tree.length === 0) {
    list.innerHTML = '<li class="tree-empty">项目目录为空</li>';
    return;
  }

  const frag = document.createDocumentFragment();
  const buildNodes = (nodes, depth, container) => {
    for (const node of nodes) {
      const li = document.createElement('li');
      li.className = 'tree-node';
      li.setAttribute('role', 'treeitem');

      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.setProperty('--tree-depth', String(depth));

      if (node.kind === 'folder') {
        const collapsed = state.collapsedFolders.has(node.path);
        row.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        if (state.selectedFolderPath === node.path) {
          row.classList.add('active');
        }
        row.innerHTML = `
          <svg class="tree-caret" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 6l3.5 4 3.5-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg class="tree-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.3 1.5h5.2A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z" fill="none" stroke="currentColor" stroke-width="1.25"/>
          </svg>
          <span class="tree-label" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</span>
          <span class="tree-node-actions">
            <button type="button" class="tree-action-btn" data-act="new-doc" title="在此目录新建文件">+</button>
            <button type="button" class="tree-action-btn danger" data-act="delete" title="删除目录">×</button>
          </span>
        `;
        row.addEventListener('click', (e) => {
          const actBtn = e.target.closest('.tree-action-btn');
          if (actBtn) {
            e.stopPropagation();
            if (actBtn.dataset.act === 'new-doc') openEntityDialog('create_doc', node.path);
            else if (actBtn.dataset.act === 'delete') promptDeleteNode(node);
            return;
          }
          state.selectedFolderPath = node.path;
          if (state.collapsedFolders.has(node.path)) state.collapsedFolders.delete(node.path);
          else state.collapsedFolders.add(node.path);
          renderFileTree();
        });
        li.appendChild(row);

        if (!collapsed && Array.isArray(node.children) && node.children.length > 0) {
          const subUl = document.createElement('ul');
          subUl.setAttribute('role', 'group');
          buildNodes(node.children, depth + 1, subUl);
          li.appendChild(subUl);
        }
      } else {
        const isActive = state.activeFilePath === node.path;
        const compileTargetPath = proj.compileTargetPath || proj.rootDocPath || '';
        const isCompileTarget = compileTargetPath ? node.path === compileTargetPath : node.isRootDoc;
        const isTexFile = /\.(?:tex|ltx)$/i.test(node.name);
        if (isActive) row.classList.add('active');
        if (node.isRootDoc || isCompileTarget) row.classList.add('is-root-doc');
        row.setAttribute('aria-selected', isActive ? 'true' : 'false');
        row.innerHTML = `
          <span class="tree-caret" aria-hidden="true"></span>
          <svg class="tree-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 2.5h5.2L12.5 5.8v7.7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.25"/>
          </svg>
          <span class="tree-label" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</span>
          ${node.isRootDoc ? '<span class="tree-badge" title="主文档">主</span>' : ''}
          ${isCompileTarget && !node.isRootDoc ? '<span class="tree-badge" title="当前编译入口">编</span>' : ''}
          <span class="tree-node-actions">
            ${isTexFile && !isCompileTarget ? '<button type="button" class="tree-action-btn" data-act="set-compile-target" title="设为编译入口并编译">▶</button>' : ''}
            <button type="button" class="tree-action-btn danger" data-act="delete" title="删除文件">×</button>
          </span>
        `;
        row.addEventListener('click', async (e) => {
          const actBtn = e.target.closest('.tree-action-btn');
          if (actBtn?.dataset.act === 'delete') {
            e.stopPropagation();
            promptDeleteNode(node);
            return;
          }
          if (actBtn?.dataset.act === 'set-compile-target') {
            e.stopPropagation();
            await setCompileTargetAndCompile(node.path);
            return;
          }
          const parentSlash = node.path.lastIndexOf('/');
          state.selectedFolderPath = parentSlash >= 0 ? node.path.slice(0, parentSlash) : '';
          openFile(node.path, { focusEditor: true });
        });
        li.appendChild(row);
      }
      container.appendChild(li);
    }
  };

  buildNodes(proj.tree, 0, frag);
  list.replaceChildren(frag);
}

// ---------- Diff & Compile Logs Rendering ----------
function renderDiffPane() {
  const container = $('diff-content');
  const proj = state.snap?.activeProject;
  const undoBtn = $('diff-undo-btn');
  undoBtn.disabled = !proj?.undoAvailable;

  if (!proj?.undoAvailable) {
    $('diff-summary').textContent = '暂无最近一轮改动对比';
    container.innerHTML = '<div class="diff-empty">当前没有可对比的最近一轮改动（Agent 或面板编辑后将自动展示变更对比）。</div>';
    return;
  }

  const desc = proj.undoSummary?.description || '最近一轮改动';
  const files = proj.undoSummary?.files || [];
  $('diff-summary').textContent = `${desc}（涉及 ${files.length} 个文件）`;

  const lines = state.activeDocData?.diffLines;
  if (!Array.isArray(lines) || lines.length === 0) {
    container.innerHTML = `<div class="diff-file-header">改动文件: ${escapeHtml(files.join(', '))}</div><div class="diff-empty">当前打开的文件 (${escapeHtml(state.activeFilePath || '未选')}) 无变更；请在左侧文件树选择已改动文件查看行级 Diff。</div>`;
    return;
  }

  let adds = 0;
  let dels = 0;
  const html = [`<div class="diff-file-header">${escapeHtml(state.activeFilePath)}</div>`];
  for (const item of lines) {
    if (item.type === 'add') adds += 1;
    if (item.type === 'del') dels += 1;
    const prefix = item.type === 'add' ? '+' : item.type === 'del' ? '-' : ' ';
    const cls = item.type === 'add' ? 'diff-add' : item.type === 'del' ? 'diff-del' : 'diff-eq';
    const ln = item.type === 'del' ? item.oldLine : item.newLine;
    html.push(`<div class="diff-line ${cls}"><span class="tabular">${String(ln ?? '').padStart(4, ' ')}</span><span>${prefix} ${escapeHtml(item.text)}</span></div>`);
  }
  $('diff-summary').textContent = `${state.activeFilePath}: +${adds} / -${dels}`;
  container.innerHTML = html.join('');
}

function refreshErrorLinesForActiveFile() {
  state.errorLines.clear();
  const diag = state.snap?.activeProject?.compileResult?.diagnostics;
  if (!diag || !state.activeFilePath) return;
  const activeBase = state.activeFilePath.split('/').pop();
  for (const err of diag.errors || []) {
    if (!err.line) continue;
    if (!err.file || err.file === state.activeFilePath || err.file.endsWith('/' + activeBase) || err.file === activeBase) {
      state.errorLines.add(Number(err.line));
    }
  }
}

function renderLogsPane() {
  const compileRes = state.snap?.activeProject?.compileResult;
  const badge = $('logs-badge');
  const list = $('logs-list');

  if (!compileRes) {
    badge.textContent = '0';
    badge.className = 'badge';
    $('logs-summary').textContent = '暂无编译日志';
    $('logs-ask-agent-btn').disabled = true;
    list.innerHTML = '<div class="diff-empty">尚未触发 Overleaf 云端编译。</div>';
    return;
  }

  const diag = compileRes.diagnostics || { errors: [], warnings: [], badboxes: [], summary: {} };
  const errCount = diag.errors?.length || 0;
  const warnCount = diag.warnings?.length || 0;
  const badCount = diag.badboxes?.length || 0;

  badge.textContent = String(errCount > 0 ? errCount : warnCount);
  badge.className = 'badge' + (errCount > 0 ? ' has-errors' : warnCount > 0 ? ' has-warnings' : '');
  $('logs-summary').textContent = `${errCount} 错误 · ${warnCount} 警告 · ${badCount} 排版提示`;
  $('logs-ask-agent-btn').disabled = errCount === 0;

  const items = [
    ...(diag.errors || []),
    ...(diag.warnings || []).slice(0, 40),
    ...(diag.badboxes || []).slice(0, 20),
  ];
  if (items.length === 0) {
    list.innerHTML = '<div class="diff-empty">编译干净通过，无 Error 或 Warning。</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `log-card is-${item.severity}`;
    card.dataset.level = item.severity;
    const locText = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : item.line ? `line ${item.line}` : '全局';
    card.innerHTML = `
      <div class="log-card-head">
        <span class="log-level">${escapeHtml(item.severity)}</span>
        <span class="log-location">${escapeHtml(locText)}</span>
      </div>
      <div class="log-message">${escapeHtml(item.message)}</div>
      ${item.snippet ? `<pre class="log-raw">${escapeHtml(item.snippet)}</pre>` : ''}
    `;
    card.addEventListener('click', () => {
      if (item.file) {
        if (state.mode === 'logs') setMode('split');
        openFile(item.file, { jumpLine: item.line || 1, focusEditor: true });
      }
    });
    frag.appendChild(card);
  }
  list.replaceChildren(frag);
}

// ---------- PDF.js Rendering & Bidirectional SyncTeX ----------
let pdfJsPromise = null;
let pdfLibModule = null;

async function ensurePdfJs() {
  if (pdfLibModule) return pdfLibModule;
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      const [libRes, workerRes] = await Promise.all([
        sFetch('/vendor/pdf.min.mjs', { method: 'GET' }),
        sFetch('/vendor/pdf.worker.min.mjs', { method: 'GET' }),
      ]);
      if (!libRes.ok) throw new Error(`加载 PDF 引擎失败 (HTTP ${libRes.status})`);
      if (!workerRes.ok) throw new Error(`加载 PDF Worker 失败 (HTTP ${workerRes.status})`);
      const [libCode, workerCode] = await Promise.all([libRes.text(), workerRes.text()]);
      const libBlobUrl = URL.createObjectURL(new Blob([libCode], { type: 'text/javascript' }));
      const workerBlobUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
      const mod = await import(libBlobUrl);
      mod.GlobalWorkerOptions.workerSrc = workerBlobUrl;
      pdfLibModule = mod;
      return mod;
    })().catch((err) => {
      pdfJsPromise = null;
      throw err;
    });
  }
  return pdfJsPromise;
}

async function loadAndRenderPdf(projectId, etag) {
  if (!projectId || !etag || etag === state.lastRenderedPdfEtag) return;
  try {
    const [pdfjsLib, res] = await Promise.all([
      ensurePdfJs(),
      sFetch(`/api/pdf?projectId=${encodeURIComponent(projectId)}&etag=${encodeURIComponent(etag)}`, {
        method: 'GET',
      }),
    ]);
    if (!res.ok) return;
    const arrayBuf = await res.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuf) });
    const pdfDoc = await loadingTask.promise;
    if (state.pdfDoc) {
      try { await state.pdfDoc.destroy(); } catch {}
      state.pdfDoc = null;
    }
    state.pdfDoc = pdfDoc;
    state.lastRenderedPdfEtag = etag;
    $('pdf-empty-state').classList.add('hidden');
    await schedulePdfRender(true);
  } catch (err) {
    $('pdf-status-text').textContent = `PDF 渲染失败: ${err.message}`;
  }
}

async function schedulePdfRender(preserveScroll = true) {
  if (state.pdfRendering) {
    state.pendingPdfRender = true;
    return;
  }
  if (!state.pdfDoc) return;

  state.pdfRendering = true;
  state.pendingPdfRender = false;

  const scroller = $('pdf-scroll-container');
  const host = $('pdf-pages-host');
  const prevTop = scroller.scrollTop;
  const prevLeft = scroller.scrollLeft;

  try {
    const numPages = state.pdfDoc.numPages;
    const availWidth = Math.max(220, scroller.clientWidth - 36);
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);

    const frag = document.createDocumentFragment();
    const newScales = new Map();

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await state.pdfDoc.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1.0 });
      const scale =
        state.pdfZoomMode === 'fit'
          ? Math.max(0.45, Math.min(3.0, availWidth / baseViewport.width))
          : state.pdfScale;
      if (pageNum === 1 && state.pdfZoomMode === 'fit') {
        state.pdfScale = scale;
      }
      newScales.set(pageNum, scale);

      const viewport = page.getViewport({ scale });
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.dataset.page = String(pageNum);
      wrap.style.width = `${Math.floor(viewport.width)}px`;
      wrap.style.height = `${Math.floor(viewport.height)}px`;

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      wrap.appendChild(canvas);
      wrap.addEventListener('dblclick', (ev) => handlePdfInverseSync(ev, pageNum, canvas));
      frag.appendChild(wrap);

      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: ctx, viewport }).promise;
    }

    state.pageRenderScale = newScales;
    host.replaceChildren(frag);
    $('pdf-zoom-label').textContent = `${Math.round(state.pdfScale * 100)}%`;

    if (preserveScroll) {
      scroller.scrollTop = prevTop;
      scroller.scrollLeft = prevLeft;
    }
    updatePdfPageIndicator();
  } finally {
    state.pdfRendering = false;
    if (state.pendingPdfRender) {
      schedulePdfRender(true);
    }
  }
  if (!state.pdfRendering && state.pendingHighlight) {
    const hl = state.pendingHighlight;
    state.pendingHighlight = null;
    applyPdfHighlight(hl);
    updatePdfPageIndicator();
  }
}

function updatePdfPageIndicator() {
  const info = $('pdf-page-info');
  if (!state.pdfDoc) {
    info.textContent = '0 / 0 页';
    return;
  }
  const numPages = state.pdfDoc.numPages;
  const scroller = $('pdf-scroll-container');
  const wraps = scroller.querySelectorAll('.pdf-page-wrap[data-page]');
  if (wraps.length === 0) {
    info.textContent = `0 / ${numPages} 页`;
    return;
  }
  const centerY = scroller.scrollTop + scroller.clientHeight * 0.4;
  let current = 1;
  let bestDist = Infinity;
  for (const w of wraps) {
    if (w.offsetTop <= centerY && w.offsetTop + w.offsetHeight >= centerY) {
      current = Number(w.dataset.page) || 1;
      break;
    }
    const mid = w.offsetTop + w.offsetHeight * 0.5;
    const d = Math.abs(mid - centerY);
    if (d < bestDist) {
      bestDist = d;
      current = Number(w.dataset.page) || 1;
    }
  }
  info.textContent = `${current} / ${numPages} 页`;
}

function applyPdfHighlight(hit) {
  if (!hit || !hit.page) return;
  if (state.pdfRendering || !state.pageRenderScale.has(hit.page)) {
    state.pendingHighlight = hit;
    return;
  }

  for (const old of document.querySelectorAll('.synctex-highlight')) {
    old.remove();
  }

  const wrap = document.querySelector(`.pdf-page-wrap[data-page="${hit.page}"]`);
  if (!wrap) return;
  const scale = state.pageRenderScale.get(hit.page) || state.pdfScale || 1;
  const box = document.createElement('div');
  box.className = 'synctex-highlight';
  const left = Math.max(0, (hit.xPt || 0) * scale - 4);
  const top = Math.max(0, (hit.yTopPt || 0) * scale - 2);
  const width = Math.max(48, (hit.wPt || 80) * scale + 8);
  const height = Math.max(14, (hit.hPt || 14) * scale + 4);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  wrap.appendChild(box);
  box.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });

  clearTimeout(state.highlightTimer);
  state.highlightTimer = setTimeout(() => {
    box.remove();
  }, 3500);
}

async function handlePdfInverseSync(ev, pageNum, canvas) {
  if (!state.activeProjectId) return;
  const rect = canvas.getBoundingClientRect();
  const scale = state.pageRenderScale.get(pageNum) || state.pdfScale || 1;
  const xPt = (ev.clientX - rect.left) / scale;
  const yTopPt = (ev.clientY - rect.top) / scale;
  try {
    const res = await apiPost('/api/synctex/inverse', {
      projectId: state.activeProjectId,
      page: pageNum,
      xPt,
      yTopPt,
    });
    if (res?.hit?.file) {
      if (state.mode === 'pdf') setMode('split');
      await openFile(res.hit.file, { jumpLine: res.hit.line || 1, focusEditor: true });
    } else {
      showAlert('当前 PDF 区域暂无可用的 SyncTeX 行号映射（请先完整编译一次）。');
    }
  } catch (err) {
    showAlert(`反向定位失败: ${err.message}`);
  }
}

async function triggerForwardSync() {
  if (!state.activeProjectId || !state.activeFilePath) {
    showAlert('请先连接项目并打开 TeX 源码后再定位 PDF。');
    return;
  }
  const line = getCursorLine($('source-editor'));
  state.focusedLine = line;
  renderEditorDecoration();
  try {
    const res = await apiPost('/api/synctex/forward', {
      projectId: state.activeProjectId,
      file: state.activeFilePath,
      line,
    });
    if (res?.hit) {
      if (state.mode === 'source') setMode('split');
      applyPdfHighlight(res.hit);
    } else {
      showAlert(`暂无 ${state.activeFilePath}:${line} 对应的 PDF SyncTeX 位置。`);
    }
  } catch (err) {
    showAlert(`正向定位失败: ${err.message}`);
  }
}

// ---------- State Polling & Snapshot Reconciliation ----------
async function pollState() {
  if (state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const data = await apiGet('/api/state', {
      projectId: state.activeProjectId,
      etag: state.etag,
    });
    if (!data?.unchanged) {
      state.etag = data.etag || '';
      await applySnapshot(data);
    }
  } catch (err) {
    $('sync-pill').dataset.status = 'error';
    $('sync-label').textContent = 'Sidecar 离线';
  } finally {
    state.pollInFlight = false;
    scheduleNextPoll();
  }
}

function scheduleNextPoll() {
  clearTimeout(state.pollTimer);
  const popupActive = state.snap?.auth?.loginPopupActive;
  const interval = document.hidden ? POLL_HIDDEN_MS : popupActive ? 800 : POLL_ACTIVE_MS;
  state.pollTimer = setTimeout(pollState, interval);
}

async function applySnapshot(snap) {
  const prevPopup = state.snap?.auth?.loginPopupActive;
  const prevAuth = state.snap?.auth?.authenticated;
  state.snap = snap;

  // Update auth modal status if open
  if (snap.auth?.authenticated) {
    $('auth-status-text').textContent = `已登录 Overleaf：${snap.auth.userEmail || '会话有效'} (${snap.auth.baseUrl})`;
    $('auth-btn').textContent = snap.auth.userEmail ? snap.auth.userEmail.split('@')[0] : '已登录';
  } else {
    $('auth-status-text').textContent = '未检测到有效 Overleaf 会话，请点击弹窗登录或粘贴 Cookie。';
    $('auth-btn').textContent = '登录 / 设置';
  }

  $('popup-login-btn').disabled = Boolean(snap.auth?.loginPopupActive);
  $('popup-cancel-btn').classList.toggle('hidden', !snap.auth?.loginPopupActive);
  if (prevPopup && !snap.auth?.loginPopupActive && snap.auth?.authenticated && !prevAuth) {
    if ($('auth-dialog').open) $('auth-dialog').close();
    if (!snap.activeProject) openConnectDialog();
  }

  // Update project selector dropdown
  const select = $('project-select');
  const seen = new Set();
  const options = [];
  for (const p of snap.connectedProjects || []) {
    seen.add(p.id);
    options.push({ id: p.id, label: `● ${p.name}` });
  }
  for (const p of snap.configuredProjects || []) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      options.push({ id: p.id, label: `○ ${p.name}` });
    }
  }
  const proj = snap.activeProject;
  if (options.length === 0) {
    select.innerHTML = '<option value="">未连接项目</option>';
  } else {
    const placeholder = !proj
      ? `<option value="">${snap.reconnectingProjectId ? '正在重连项目…' : '选择项目连接…'}</option>`
      : '';
    select.innerHTML =
      placeholder +
      options
        .map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)}</option>`)
        .join('');
    if (!proj) {
      select.value = '';
    }
  }

  if (proj) {
    state.activeProjectId = proj.id;
    select.value = proj.id;

    $('sync-pill').dataset.status = proj.syncStatus || 'idle';
    const statusMap = {
      connected: '实时已同步',
      compiling: '云端编译中…',
      reconnecting: '重连中…',
      connecting: '连接中…',
      error: '同步异常',
      disconnected: '已断开',
    };
    $('sync-label').textContent = statusMap[proj.syncStatus] || proj.syncStatus || '已连接';
    $('auto-compile-toggle').checked = Boolean(proj.autoCompile);
    $('undo-btn').disabled = !proj.undoAvailable;
    $('compile-btn').disabled = Boolean(proj.compiling);
    const compileTarget = proj.compileTargetPath || proj.rootDocPath || '';
    $('compile-btn').title = compileTarget
      ? `编译 ${compileTarget} (Ctrl+S)`
      : '触发 Overleaf 云端编译 (Ctrl+S)';
    $('mirror-path-text').textContent = proj.mirrorDir;
    $('mirror-path-text').title = proj.mirrorDir;

    if (proj.compileResult) {
      const cr = proj.compileResult;
      const timeStr = cr.compiledAt ? new Date(cr.compiledAt).toLocaleTimeString() : '';
      $('pdf-status-text').textContent =
        cr.status === 'backoff'
          ? '云端频控排队中…'
          : cr.ok
            ? `编译成功 (${cr.durationMs}ms · ${timeStr})`
            : `编译异常 (${cr.diagnostics?.summary?.errorCount || 0} 错误)`;
    } else {
      $('pdf-status-text').textContent = proj.compiling ? '编译中…' : '待编译';
    }

    if (proj.guardrailAlert) {
      showAlert(proj.guardrailAlert.message, proj.guardrailAlert.id);
    } else if (proj.lastError) {
      showAlert(proj.lastError, `err:${proj.lastError}`);
    } else if (!state.lastAlertKey || state.lastAlertKey.startsWith('err:')) {
      state.lastAlertKey = '';
      $('alert-banner').classList.add('hidden');
    }

    renderFileTree();
    renderLogsPane();

    // Sync active file or respond to Agent `overleaf_focus` / edit focus updates
    let refreshedEditor = false;
    const focus = proj.focusState;
    if (focus && focus.seq !== state.lastFocusSeq && focus.file) {
      state.lastFocusSeq = focus.seq;
      if (state.activeFilePath !== focus.file) {
        await openFile(focus.file, { jumpLine: focus.line });
        refreshedEditor = true;
      } else if (state.activeDocData?.kind === 'doc' && !state.editorDirty) {
        const fresh = await apiGet('/api/doc', { projectId: proj.id, path: focus.file });
        state.activeDocData = fresh;
        const editor = $('source-editor');
        if (editor.value !== fresh.content) {
          editor.value = fresh.content;
        }
        scrollEditorToLine(focus.line);
        refreshedEditor = true;
      }
      if (focus.highlight) {
        applyPdfHighlight(focus.highlight);
      }
    } else if (!state.activeFilePath) {
      const fallbackFile = proj.rootDocPath || findFirstDocPath(proj.tree);
      if (fallbackFile) {
        await openFile(fallbackFile);
        refreshedEditor = true;
      }
    } else if (!state.editorDirty && state.activeDocData?.kind === 'doc') {
      // Check quietly for remote/watcher updates to currently open file
      try {
        const fresh = await apiGet('/api/doc', { projectId: proj.id, path: state.activeFilePath });
        if (fresh.version !== state.activeDocVersion || fresh.content !== $('source-editor').value) {
          const editor = $('source-editor');
          const prevScroll = editor.scrollTop;
          const prevSelStart = editor.selectionStart;
          const prevSelEnd = editor.selectionEnd;
          state.activeDocData = fresh;
          state.activeDocVersion = fresh.version;
          editor.value = fresh.content;
          editor.scrollTop = prevScroll;
          if (document.activeElement === editor) {
            editor.setSelectionRange(
              Math.min(prevSelStart, fresh.content.length),
              Math.min(prevSelEnd, fresh.content.length)
            );
          }
          refreshErrorLinesForActiveFile();
          renderEditorDecoration();
          refreshedEditor = true;
        }
      } catch {}
    }

    if (!refreshedEditor && state.activeFilePath && state.activeDocData?.kind === 'doc') {
      refreshErrorLinesForActiveFile();
      renderEditorDecoration();
    }

    if (proj.compileResult?.pdfEtag && proj.compileResult.pdfEtag !== state.lastRenderedPdfEtag) {
      await loadAndRenderPdf(proj.id, proj.compileResult.pdfEtag);
    }
    if (state.mode === 'diff') renderDiffPane();
  } else {
    state.activeProjectId = '';
    $('sync-pill').dataset.status = snap.reconnectingProjectId
      ? 'connecting'
      : snap.auth?.authenticated
        ? 'dirty'
        : 'idle';
    $('sync-label').textContent = snap.reconnectingProjectId
      ? '自动重连项目中…'
      : snap.auth?.authenticated
        ? '请选择项目'
        : '未登录';
    $('undo-btn').disabled = true;
    $('compile-btn').disabled = Boolean(!(snap.auth?.authenticated && snap.activeProjectId));
    $('mirror-path-text').textContent = '未挂载本地镜像';
    if (state.lastAlertKey?.startsWith('err:')) {
      state.lastAlertKey = '';
      $('alert-banner').classList.add('hidden');
    }
    renderFileTree();
    renderLogsPane();
  }
}

function findFirstDocPath(nodes) {
  for (const n of nodes || []) {
    if (n.kind === 'doc') return n.path;
    if (n.children) {
      const sub = findFirstDocPath(n.children);
      if (sub) return sub;
    }
  }
  return '';
}

// ---------- Modals & Actions ----------
function openAuthDialog() {
  $('auth-error-msg').classList.add('hidden');
  if (state.snap?.auth?.baseUrl) {
    $('base-url-input').value = state.snap.auth.baseUrl;
  }
  $('auth-dialog').showModal();
}

async function openConnectDialog() {
  $('connect-error-msg').classList.add('hidden');
  if (state.snap?.activeProject?.mirrorDir) {
    $('mirror-dir-input').value = '';
  }
  $('connect-dialog').showModal();
  await refreshProjectPicker(true);
}

async function refreshProjectPicker(refreshRemote = false) {
  const list = $('project-picker-list');
  list.innerHTML = '<div class="tree-empty">正在拉取 Overleaf 项目列表…</div>';
  try {
    const query = $('project-filter-input').value.trim();
    const res = await apiGet('/api/projects', {
      refresh: refreshRemote ? '1' : '',
      query,
    });
    const projects = res.projects || [];
    if (projects.length === 0) {
      list.innerHTML = '<div class="tree-empty">未找到匹配的 Overleaf 项目</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const p of projects) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'project-picker-item' + (p.id === state.activeProjectId ? ' active' : '');
      btn.innerHTML = `
        <span class="project-picker-name">${escapeHtml(p.name)}</span>
        <span class="project-picker-meta">${escapeHtml(p.id)}${p.accessLevel ? ` · ${escapeHtml(p.accessLevel)}` : ''}</span>
      `;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        $('connect-error-msg').classList.add('hidden');
        try {
          const mirrorDir = $('mirror-dir-input').value.trim();
          const resConn = await apiPost('/api/project/connect', {
            projectId: p.id,
            mirrorDir,
          });
          state.activeProjectId = resConn.projectId;
          state.activeFilePath = '';
          state.lastRenderedPdfEtag = '';
          $('connect-dialog').close();
          state.etag = '';
          await pollState();
        } catch (err) {
          $('connect-error-msg').textContent = err.message;
          $('connect-error-msg').classList.remove('hidden');
        } finally {
          btn.disabled = false;
        }
      });
      frag.appendChild(btn);
    }
    list.replaceChildren(frag);
  } catch (err) {
    list.innerHTML = '';
    $('connect-error-msg').textContent = err.message;
    $('connect-error-msg').classList.remove('hidden');
  }
}

function openEntityDialog(action, parentPath = state.selectedFolderPath) {
  if (!state.activeProjectId) {
    showAlert('请先连接 Overleaf 项目');
    return;
  }
  state.pendingEntityAction = { action, parentPath };
  $('entity-dialog-title').textContent = action === 'create_doc' ? '新建 Overleaf 文档' : '新建 Overleaf 文件夹';
  $('entity-parent-label').textContent = `目标目录：/${parentPath || ''}`;
  $('entity-name-input').value = '';
  $('entity-name-input').placeholder = action === 'create_doc' ? '例如：appendix.tex' : '例如：figs';
  $('entity-error-msg').classList.add('hidden');
  $('entity-dialog').showModal();
}

function promptDeleteNode(node) {
  state.pendingDeleteTarget = node;
  $('confirm-delete-title').textContent = `确认删除 ${node.name}`;
  $('confirm-delete-desc').textContent = node.isRootDoc
    ? `警告：${node.path} 是当前项目的主文档！删除后将导致编译失败，确认继续从云端与本地镜像删除吗？`
    : `确认从 Overleaf 云端与本地镜像中删除 ${node.path} 吗？`;
  $('confirm-delete-dialog').showModal();
}

async function setCompileTargetAndCompile(relPath) {
  const targetProjectId = state.activeProjectId;
  if (!targetProjectId || !relPath) return;
  try {
    await apiPost('/api/compile/target', {
      projectId: targetProjectId,
      path: relPath,
    });
    await pollState();
    await triggerCompile();
  } catch (err) {
    showAlert(`切换编译入口失败: ${err.message}`);
  }
}

async function triggerCompile() {
  const targetProjectId = state.activeProjectId || state.snap?.activeProjectId || '';
  if (!targetProjectId || !state.snap?.auth?.authenticated) {
    showAlert('请先登录并连接一个 Overleaf 项目后再编译。');
    return;
  }
  await flushEditorSave();
  $('compile-btn').disabled = true;
  $('sync-pill').dataset.status = 'compiling';
  $('sync-label').textContent = '云端编译中…';
  try {
    await apiPost('/api/compile', { projectId: targetProjectId, reason: 'manual' });
    if (state.lastAlertKey?.startsWith('err:')) {
      state.lastAlertKey = '';
      $('alert-banner').classList.add('hidden');
    }
    state.etag = '';
    await pollState();
  } catch (err) {
    showAlert(`云端编译失败: ${err.message}`);
  } finally {
    $('compile-btn').disabled = false;
  }
}

async function triggerUndo() {
  if (!state.activeProjectId) {
    showAlert('请先连接一个 Overleaf 项目。');
    return;
  }
  $('undo-btn').disabled = true;
  try {
    const res = await apiPost('/api/undo', { projectId: state.activeProjectId });
    if (!res.undone) {
      showAlert(res.message || '暂无可撤销的改动');
    } else {
      state.editorDirty = false;
      state.etag = '';
      await pollState();
      if (state.activeFilePath) {
        await openFile(state.activeFilePath);
      }
    }
  } catch (err) {
    showAlert(`撤销失败: ${err.message}`);
  }
}

async function sendMessageToAgent(text) {
  if (!window.sidecar?.agent?.sendMessage) {
    showAlert('当前非 Antigravity 宿主环境，无法直接向对话发送消息。');
    return;
  }
  try {
    await window.sidecar.agent.sendMessage(text);
    showAlert('已将选中上下文发给当前对话中的 Agent 处理。');
  } catch (err) {
    showAlert(`发送给 Agent 失败: ${err.message}`);
  }
}

// ---------- Event Wiring ----------
function initResizer() {
  const resizer = $('pane-resizer');
  const split = $('split-container');
  let dragging = false;

  resizer.addEventListener('pointerdown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    resizer.setPointerCapture(e.pointerId);
  });

  resizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.max(25, Math.min(75, ((e.clientX - rect.left) / rect.width) * 100));
    split.style.setProperty('--split-cols', `minmax(180px, ${pct.toFixed(1)}%) 6px minmax(180px, 1fr)`);
  });

  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    if (state.pdfDoc && state.pdfZoomMode === 'fit') {
      schedulePdfRender(true);
    }
  };
  resizer.addEventListener('pointerup', stopDrag);
  resizer.addEventListener('pointercancel', stopDrag);
}

function bindEvents() {
  $('tree-toggle-btn').addEventListener('click', () => setTreeOpen(!state.treeOpen));

  for (const btn of document.querySelectorAll('.mode-btn')) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  }

  $('project-select').addEventListener('change', async (e) => {
    const projectId = e.target.value;
    if (!projectId) return;
    try {
      await apiPost('/api/project/connect', { projectId });
      state.activeProjectId = projectId;
      state.activeFilePath = '';
      state.lastRenderedPdfEtag = '';
      state.etag = '';
      await pollState();
    } catch (err) {
      showAlert(`切换项目失败: ${err.message}`);
    }
  });

  $('connect-project-btn').addEventListener('click', () => {
    if (!state.snap?.auth?.authenticated) openAuthDialog();
    else openConnectDialog();
  });

  $('auth-btn').addEventListener('click', openAuthDialog);
  $('auth-close-btn').addEventListener('click', () => $('auth-dialog').close());
  $('connect-close-btn').addEventListener('click', () => $('connect-dialog').close());
  $('entity-cancel-btn').addEventListener('click', () => $('entity-dialog').close());

  $('auto-compile-toggle').addEventListener('change', async (e) => {
    if (!state.activeProjectId) return;
    try {
      await apiPost('/api/project/settings', {
        projectId: state.activeProjectId,
        autoCompile: e.target.checked,
        bindConversation: true,
      });
    } catch (err) {
      showAlert(`更新设置失败: ${err.message}`);
    }
  });

  $('compile-btn').addEventListener('click', triggerCompile);
  $('undo-btn').addEventListener('click', triggerUndo);
  $('diff-undo-btn').addEventListener('click', triggerUndo);
  $('alert-dismiss-btn').addEventListener('click', async () => {
    hideAlert();
    if (state.activeProjectId) {
      await apiPost('/api/guardrail/dismiss', { projectId: state.activeProjectId }).catch(() => {});
    }
  });

  $('copy-mirror-btn').addEventListener('click', async () => {
    const p = $('mirror-path-text').textContent;
    if (!p || p.startsWith('未挂载')) {
      showAlert('当前尚未挂载本地镜像，请先连接一个 Overleaf 项目。');
      return;
    }
    try {
      await navigator.clipboard.writeText(p);
      $('copy-mirror-btn').textContent = '已复制';
      setTimeout(() => { $('copy-mirror-btn').textContent = '复制'; }, 1200);
    } catch {
      showAlert(`镜像路径：${p}`);
    }
  });

  // Editor events
  const editor = $('source-editor');
  editor.addEventListener('input', () => {
    state.focusedLine = getCursorLine(editor);
    renderEditorDecoration();
    scheduleEditorSave();
  });
  editor.addEventListener('scroll', syncEditorScroll);
  editor.addEventListener('click', (e) => {
    state.focusedLine = getCursorLine(editor);
    renderEditorDecoration();
    if (e.altKey) triggerForwardSync();
  });
  editor.addEventListener('keyup', () => {
    const line = getCursorLine(editor);
    if (line !== state.focusedLine) {
      state.focusedLine = line;
      renderEditorDecoration();
    }
  });
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      triggerCompile();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.setRangeText('  ', start, end, 'end');
      renderEditorDecoration();
      scheduleEditorSave();
    }
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      triggerCompile();
    }
  }, { capture: true });

  $('save-doc-btn').addEventListener('click', async () => {
    if (!state.activeProjectId || !state.activeFilePath) {
      showAlert('请先连接项目并打开文档后再同步。');
      return;
    }
    await flushEditorSave();
    const btn = $('save-doc-btn');
    btn.textContent = '已同步';
    setTimeout(() => { btn.textContent = '同步'; }, 1000);
  });
  $('forward-sync-btn').addEventListener('click', triggerForwardSync);

  $('send-to-agent-btn').addEventListener('click', () => {
    if (!state.activeFilePath) {
      showAlert('请先连接项目并打开一个文件后再发送给 Agent。');
      return;
    }
    const editor = $('source-editor');
    const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
    const line = getCursorLine(editor);
    const mirrorPath = state.snap?.activeProject?.mirrorDir || '';
    const msg = sel
      ? `请帮我修改 Overleaf 文件 \`${state.activeFilePath}\`（第 ${line} 行附近，本地镜像 \`${mirrorPath}\`）的这段内容：\n\`\`\`latex\n${sel}\n\`\`\``
      : `请查看并优化 Overleaf 文件 \`${state.activeFilePath}\` 第 ${line} 行附近的内容（本地镜像 \`${mirrorPath}\`）。`;
    sendMessageToAgent(msg);
  });

  $('logs-ask-agent-btn').addEventListener('click', () => {
    const diag = state.snap?.activeProject?.compileResult?.diagnostics;
    const errors = diag?.errors || [];
    if (errors.length === 0) return;
    const summary = errors
      .slice(0, 6)
      .map((e, idx) => `${idx + 1}. ${e.file || 'main'}:${e.line || '?'} — ${e.message}`)
      .join('\n');
    sendMessageToAgent(
      `Overleaf 云端编译报错如下，请直接修改本地镜像文件并运行 \`overleaf_compile\` 修复所有 LaTeX Error：\n${summary}`
    );
  });

  // Tree CRUD & upload
  $('new-doc-btn').addEventListener('click', () => openEntityDialog('create_doc'));
  $('new-folder-btn').addEventListener('click', () => openEntityDialog('create_folder'));
  $('upload-file-btn').addEventListener('click', () => {
    if (!state.activeProjectId) {
      showAlert('请先连接 Overleaf 项目');
      return;
    }
    $('upload-file-input').click();
  });
  $('upload-file-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !state.activeProjectId) return;
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const fileBase64 = btoa(bin);
    try {
      await apiPost('/api/entity/action', {
        projectId: state.activeProjectId,
        action: 'upload_file',
        parentPath: state.selectedFolderPath,
        name: file.name,
        fileBase64,
      });
      state.etag = '';
      await pollState();
    } catch (err) {
      showAlert(`上传失败: ${err.message}`);
    }
  });

  $('entity-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      $('entity-confirm-btn').click();
    }
  });

  $('entity-confirm-btn').addEventListener('click', async () => {
    const pending = state.pendingEntityAction;
    const name = $('entity-name-input').value.trim();
    if (!pending || !name) return;
    try {
      const res = await apiPost('/api/entity/action', {
        projectId: state.activeProjectId,
        action: pending.action,
        parentPath: pending.parentPath,
        name,
      });
      $('entity-dialog').close();
      state.etag = '';
      await pollState();
      if (pending.action === 'create_doc' && res?.path) {
        await openFile(res.path, { focusEditor: true });
      }
    } catch (err) {
      $('entity-error-msg').textContent = err.message;
      $('entity-error-msg').classList.remove('hidden');
    }
  });

  const confirmDialog = $('confirm-delete-dialog');
  confirmDialog.addEventListener('close', async () => {
    const choice = confirmDialog.returnValue;
    confirmDialog.returnValue = '';
    const node = state.pendingDeleteTarget;
    state.pendingDeleteTarget = null;
    if (choice !== 'delete' || !node || !state.activeProjectId) return;
    try {
      await apiPost('/api/entity/action', {
        projectId: state.activeProjectId,
        action: 'delete',
        path: node.path,
        confirmDelete: true,
      });
      if (state.activeFilePath === node.path) {
        state.activeFilePath = '';
        state.activeDocData = null;
      }
      state.etag = '';
      await pollState();
    } catch (err) {
      showAlert(`删除失败: ${err.message}`);
    }
  });

  // Auth dialog handlers
  $('popup-login-btn').addEventListener('click', async () => {
    $('auth-error-msg').classList.add('hidden');
    try {
      await apiPost('/api/auth/popup', {
        action: 'start',
        baseUrl: $('base-url-input').value.trim(),
      });
      state.etag = '';
      await pollState();
    } catch (err) {
      $('auth-error-msg').textContent = err.message;
      $('auth-error-msg').classList.remove('hidden');
    }
  });

  $('popup-cancel-btn').addEventListener('click', async () => {
    await apiPost('/api/auth/popup', { action: 'cancel' }).catch(() => {});
    state.etag = '';
    await pollState();
  });

  $('save-cookie-btn').addEventListener('click', async () => {
    $('auth-error-msg').classList.add('hidden');
    const cookieInput = $('cookie-input').value.trim();
    if (!cookieInput) {
      $('auth-error-msg').textContent = '请粘贴 Cookie 或 overleaf_session2 内容。';
      $('auth-error-msg').classList.remove('hidden');
      return;
    }
    $('save-cookie-btn').disabled = true;
    try {
      await apiPost('/api/auth/cookie', {
        cookieInput,
        baseUrl: $('base-url-input').value.trim(),
      });
      $('cookie-input').value = '';
      $('auth-dialog').close();
      state.etag = '';
      await pollState();
      if (!state.activeProjectId) {
        openConnectDialog();
      }
    } catch (err) {
      $('auth-error-msg').textContent = err.message;
      $('auth-error-msg').classList.remove('hidden');
    } finally {
      $('save-cookie-btn').disabled = false;
    }
  });

  $('logout-btn').addEventListener('click', async () => {
    await apiPost('/api/auth/logout', {}).catch(() => {});
    state.activeProjectId = '';
    state.activeFilePath = '';
    state.pdfDoc = null;
    state.lastRenderedPdfEtag = '';
    $('auth-dialog').close();
    state.etag = '';
    await pollState();
  });

  // Connect dialog filter
  let filterTimer = 0;
  $('project-filter-input').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => refreshProjectPicker(false), 180);
  });

  // PDF zoom controls
  $('pdf-zoom-out').addEventListener('click', () => {
    if (!state.pdfDoc) {
      showAlert('连接项目并完成云端编译后即可缩放 PDF 预览。');
      return;
    }
    state.pdfZoomMode = 'manual';
    state.pdfScale = Math.max(0.45, +(state.pdfScale - 0.15).toFixed(2));
    schedulePdfRender(true);
  });
  $('pdf-zoom-in').addEventListener('click', () => {
    if (!state.pdfDoc) {
      showAlert('连接项目并完成云端编译后即可缩放 PDF 预览。');
      return;
    }
    state.pdfZoomMode = 'manual';
    state.pdfScale = Math.min(3.0, +(state.pdfScale + 0.15).toFixed(2));
    schedulePdfRender(true);
  });
  $('pdf-zoom-fit').addEventListener('click', () => {
    if (!state.pdfDoc) {
      showAlert('连接项目并完成云端编译后即可缩放 PDF 预览。');
      return;
    }
    state.pdfZoomMode = 'fit';
    schedulePdfRender(true);
  });

  let pdfScrollRaf = 0;
  $('pdf-scroll-container').addEventListener('scroll', () => {
    if (pdfScrollRaf) return;
    pdfScrollRaf = requestAnimationFrame(() => {
      pdfScrollRaf = 0;
      updatePdfPageIndicator();
    });
  }, { passive: true });

  // Resize observer keeps PDF fit-width sharp when Aux Pane resizes
  let resizeTimer = 0;
  new ResizeObserver(() => {
    if (!state.pdfDoc || state.pdfZoomMode !== 'fit') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => schedulePdfRender(true), 180);
  }).observe($('pdf-scroll-container'));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollState();
  });

  initResizer();
}

// ---------- Boot ----------
bindEvents();
pollState();
})();
