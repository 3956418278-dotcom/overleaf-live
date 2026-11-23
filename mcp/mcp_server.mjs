#!/usr/bin/env node
/**
 * Stdio MCP Server (JSON-RPC 2.0, MCP protocol 2024-11-05 / 2025-03-26) for
 * Antigravity Overleaf Live Plugin (`overleaf-live`).
 *
 * Forwards requests to the running Sidecar daemon's authenticated loopback IPC
 * (`STATE_DIR/daemon.json`), falling back cleanly to a local `SyncManager` if
 * the Sidecar has not been started yet.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readDaemonInfo } from '../sidecars/overleaf_live/lib/state_store.mjs';
import { SyncManager, dispatchIpcAction } from '../sidecars/overleaf_live/lib/sync_manager.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_VERSIONS = new Set(['2024-11-05', '2025-03-26']);
const SERVER_INFO = { name: 'overleaf-live', version: '1.0.0' };

let fallbackSync = null;

function getFallbackSync() {
  if (!fallbackSync) fallbackSync = new SyncManager();
  return fallbackSync;
}

async function callBackend(action, params = {}) {
  const daemon = readDaemonInfo();
  if (daemon?.port && daemon?.token) {
    try {
      const res = await fetch(`http://${daemon.host || '127.0.0.1'}:${daemon.port}/ipc/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-overleaf-ipc-token': daemon.token,
        },
        body: JSON.stringify({ action, params }),
        signal: AbortSignal.timeout(120_000),
      });
      const data = await res.json();
      if (!data.ok) {
        return { error: data.error || `IPC HTTP ${res.status}`, isError: true };
      }
      return { result: data.result, isError: false };
    } catch {
      // Sidecar daemon might have restarted or exited; fall back cleanly.
    }
  }

  try {
    const result = await dispatchIpcAction(getFallbackSync(), action, params);
    return { result, isError: false };
  } catch (err) {
    return { error: err?.message || String(err), isError: true };
  }
}

function defaultConvId(args) {
  return String(args?.conversation_id || process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
}

const TOOLS = [
  {
    name: 'overleaf_status',
    description:
      '检查 Overleaf 会话登录状态、当前对话绑定的项目、本地实时镜像目录路径、WebSocket 同步状态与最近一次云端编译结果。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '可选：指定 Overleaf 项目 ID 或 URL。' },
        conversation_id: { type: 'string', description: '可选：覆盖当前对话 ID。' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const { result, error, isError } = await callBackend('status', {
        projectId: args.project_id,
        conversationId: defaultConvId(args),
      });
      if (isError) return { payload: { error }, isError: true };
      return {
        payload: {
          authenticated: result.auth?.authenticated ?? false,
          userEmail: result.auth?.userEmail || '',
          baseUrl: result.auth?.baseUrl || 'https://www.overleaf.com',
          boundProjectId: result.boundProjectId || '',
          activeProject: result.activeProject
            ? {
                id: result.activeProject.id,
                name: result.activeProject.name,
                mirrorDir: result.activeProject.mirrorDir,
                syncStatus: result.activeProject.syncStatus,
                autoCompile: result.activeProject.autoCompile,
                rootDocPath: result.activeProject.rootDocPath,
                undoAvailable: result.activeProject.undoAvailable,
                compileResult: result.activeProject.compileResult,
              }
            : null,
          configuredProjects: result.configuredProjects || [],
          hint: !result.auth?.authenticated
            ? '用户尚未登录 Overleaf。请引导用户打开 [Overleaf 实时工作台](sidecar://overleaf-live/overleaf_live/) 点击“登录 / 设置”完成弹窗登录或粘贴 Cookie。'
            : undefined,
        },
        isError: false,
      };
    },
  },
  {
    name: 'overleaf_list_projects',
    description: '列出当前已登录 Overleaf 账号下的项目列表，支持关键字过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按项目名称或 ID 过滤。' },
        refresh: { type: 'boolean', description: '是否强制向 Overleaf 重新拉取最新项目列表。' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const { result, error, isError } = await callBackend('list_projects', {
        query: args.query || '',
        refresh: Boolean(args.refresh),
      });
      if (isError) return { payload: { error }, isError: true };
      return { payload: result, isError: false };
    },
  },
  {
    name: 'overleaf_connect_project',
    description:
      '连接指定 Overleaf 项目，拉取文件树并在本地镜像目录建立实时双向 OT 同步。返回的 mirrorDir 可直接用 read_file/edit_file/write_file 操作。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Overleaf 项目 ID 或完整项目 URL（如 https://www.overleaf.com/project/<id>）。',
        },
        mirror_dir: {
          type: 'string',
          description: '可选：自定义本地镜像绝对路径（如当前仓库的 ./paper）；留空则自动存入 scratch/overleaf/<项目名>/。',
        },
        auto_initial_compile: {
          type: 'boolean',
          description: '连接后是否立即在后台触发一次云端初始编译以生成 PDF 预览（默认 true）。',
        },
        conversation_id: { type: 'string', description: '可选：绑定到指定对话 ID。' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const { result, error, isError } = await callBackend('connect_project', {
        projectId: args.project_id,
        mirrorDir: args.mirror_dir,
        autoInitialCompile: args.auto_initial_compile !== false,
        conversationId: defaultConvId(args),
      });
      if (isError) return { payload: { error }, isError: true };
      return { payload: result, isError: false };
    },
  },
  {
    name: 'overleaf_compile',
    description:
      '强制刷齐本地待同步修改到 Overleaf 并运行云端编译，返回结构化 output.log 诊断（errors/warnings/badboxes）并刷新侧栏 PDF 预览与 SyncTeX。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '可选：项目 ID；默认使用当前对话绑定的项目。' },
        target_file: {
          type: 'string',
          description: '可选：指定本次编译的入口 .tex 文件相对路径；默认使用项目主文档或工作台选中的编译入口。',
        },
        draft: { type: 'boolean', description: '是否以草稿快速模式编译（默认 false）。' },
        conversation_id: { type: 'string' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const { result, error, isError } = await callBackend('compile', {
        projectId: args.project_id,
        targetFile: args.target_file,
        draft: Boolean(args.draft),
        reason: 'agent',
        conversationId: defaultConvId(args),
      });
      if (isError) return { payload: { error }, isError: true };
      const diag = result?.diagnostics || { errors: [], warnings: [], badboxes: [], summary: {} };
      return {
        payload: {
          status: result.status,
          ok: result.ok,
          durationMs: result.durationMs,
          hasPdf: result.hasPdf,
          hasSynctex: result.hasSynctex,
          errorCount: diag.summary?.errorCount ?? diag.errors.length,
          warningCount: diag.summary?.warningCount ?? diag.warnings.length,
          badboxCount: diag.summary?.badboxCount ?? diag.badboxes.length,
          errors: diag.errors,
          warnings: diag.warnings.slice(0, 25),
          badboxes: diag.badboxes.slice(0, 15),
        },
        isError: false,
      };
    },
  },
  {
    name: 'overleaf_focus',
    description:
      '将右侧栏工作台的源码编辑器定位高亮到指定文件与行号，并通过 SyncTeX 自动同步滚动和高亮 PDF 对应位置。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '项目内相对路径（如 sections/method.tex）。' },
        line: { type: 'integer', description: '1-based 目标行号。' },
        project_id: { type: 'string' },
        conversation_id: { type: 'string' },
      },
      required: ['file', 'line'],
      additionalProperties: false,
    },
    async handler(args) {
      const { result, error, isError } = await callBackend('focus', {
        projectId: args.project_id,
        file: args.file,
        line: args.line,
        conversationId: defaultConvId(args),
      });
      if (isError) return { payload: { error }, isError: true };
      return { payload: result, isError: false };
    },
  },
  {
    name: 'overleaf_file_ops',
    description:
      '在 Overleaf 项目与本地镜像中显式新建文档、新建文件夹、上传本地图片/附件，或删除条目（删除主文档或文件夹必须显式传 confirm_delete: true）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_doc', 'create_folder', 'upload_file', 'delete'],
          description: '要执行的项目条目操作。',
        },
        parent_path: { type: 'string', description: '父目录相对路径（根目录留空）。' },
        name: { type: 'string', description: '新建或上传的文件/文件夹名称。' },
        path: { type: 'string', description: 'delete 时的目标相对路径。' },
        local_source_path: {
          type: 'string',
          description: 'upload_file 时读取本地文件的绝对路径并上传到 Overleaf 与镜像目录。',
        },
        confirm_delete: {
          type: 'boolean',
          description: '删除高风险条目（主 .tex 或文件夹）时必须设为 true。',
        },
        project_id: { type: 'string' },
        conversation_id: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async handler(args) {
      let fileBase64 = '';
      let uploadName = args.name || '';
      if (args.action === 'upload_file') {
        if (!args.local_source_path) {
          return { payload: { error: 'upload_file 需要提供 local_source_path' }, isError: true };
        }
        const buf = readFileSync(args.local_source_path);
        fileBase64 = buf.toString('base64');
        if (!uploadName) {
          uploadName = args.local_source_path.split(/[\\/]/).pop() || 'upload.bin';
        }
      }
      const { result, error, isError } = await callBackend('file_ops', {
        projectId: args.project_id,
        op: args.action,
        parentPath: args.parent_path || '',
        name: uploadName,
        path: args.path || '',
        fileBase64,
        confirmDelete: Boolean(args.confirm_delete),
        conversationId: defaultConvId(args),
      });
      if (isError) return { payload: { error }, isError: true };
      return { payload: result, isError: false };
    },
  },
  {
    name: 'overleaf_undo',
    description: '单步撤回最近一轮修改（同时恢复本地镜像文件并实时通过 OT 回滚 Overleaf 云端）。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        conversation_id: { type: 'string' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const { result, error, isError } = await callBackend('undo', {
        projectId: args.project_id,
        conversationId: defaultConvId(args),
      });
      if (isError) return { payload: { error }, isError: true };
      return { payload: result, isError: false };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export async function handleJsonRpcRequest(req) {
  const { id = null, method, params = {} } = req || {};
  const ok = (result) => (id === null ? null : { jsonrpc: '2.0', id, result });
  const err = (code, message) => (id === null ? null : { jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    const clientVer = params?.protocolVersion;
    const negotiated = SUPPORTED_VERSIONS.has(clientVer) ? clientVer : PROTOCOL_VERSION;
    return ok({
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') {
    return null;
  }
  if (method === 'ping') {
    return ok({});
  }
  if (method === 'tools/list') {
    return ok({
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const tool = TOOL_MAP.get(name);
    if (!tool) return err(-32601, `Unknown tool: ${name}`);
    const toolArgs = params?.arguments || {};
    if (typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
      return err(-32602, 'Tool arguments must be a JSON object.');
    }
    try {
      const { payload, isError } = await tool.handler(toolArgs);
      return ok({
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: Boolean(isError),
      });
    } catch (e) {
      return ok({
        content: [{ type: 'text', text: JSON.stringify({ error: e?.message || String(e) }, null, 2) }],
        isError: true,
      });
    }
  }

  if (id === null) return null;
  return err(-32601, `Method not found: ${method}`);
}

function runStdio() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`
      );
      return;
    }
    const resp = await handleJsonRpcRequest(req);
    if (resp !== null) {
      process.stdout.write(`${JSON.stringify(resp)}\n`);
    }
  });
}

const isEntrypoint =
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isEntrypoint && !process.env.OVERLEAF_MCP_IMPORT_ONLY) {
  runStdio();
}
