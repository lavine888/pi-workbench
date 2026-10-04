/**
 * Subagent Server — 常驻守护进程
 *
 * 借鉴 OpenAI Codex exec-server 架构:
 * - JSON-RPC over stdio 双向通信
 * - 进程池管理，避免冷启动
 * - 流式输出实时推送
 * - 完整进程生命周期控制
 *
 * 启动方式: node subagent-server.ts
 * 通信协议: stdin/stdout 走 JSON-RPC 2.0 (每行一个 JSON 对象)
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

// ── 配置 ──────────────────────────────────────────────────────────

const CONFIG = {
  maxWorkers: 4,           // 最大并行 worker 数
  workerIdleTimeoutMs: 5 * 60 * 1000,  // worker 空闲 5 分钟后回收
  taskTimeoutMs: 10 * 60 * 1000,       // 单任务超时 10 分钟
  maxRetries: 2,           // 任务失败最大重试次数
  stdoutBufferSize: 64 * 1024,  // 64KB 缓冲区
};

// ── 类型 ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

interface WorkerProcess {
  id: number;
  process: ReturnType<typeof spawn> | null;
  busy: boolean;
  taskId: string | null;
  lastUsed: number;
  abortController: AbortController | null;
}

interface TaskState {
  id: string;
  agent: string;
  task: string;
  cwd: string;
  systemPrompt: string;
  messages: unknown[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number; contextTokens: number };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
  exitCode: number;
  startTime: number;
  workerId: number | null;
  aborted: boolean;
}

// ── 状态 ──────────────────────────────────────────────────────────

const workers: WorkerProcess[] = [];
const pendingTasks = new Map<string, { resolve: (result: TaskState) => void; reject: (err: Error) => void }>();
const runningTasks = new Map<string, TaskState>();
let nextWorkerId = 1;
let nextTaskId = 1;
let serverStarted = false;

// ── 工具函数 ──────────────────────────────────────────────────────

function sendMessage(msg: JsonRpcMessage): void {
  const line = JSON.stringify(msg);
  // stdout 是通信通道，stderr 是日志通道
  process.stdout.write(line + "\n");
}

function log(level: "info" | "warn" | "error", message: string, data?: unknown): void {
  const entry = { time: new Date().toISOString(), level, message, data };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

function findPiPath(): string {
  // 尝试找到 pi 可执行文件
  const candidates = [
    process.execPath,                    // 当前 node
    process.argv[1],                     // 当前脚本路径
  ];

  // 尝试从 PATH 找 pi
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const piPath = execSync(`${which} pi`, { encoding: "utf8", timeout: 5000 }).trim().split("\n")[0];
    if (piPath) return piPath;
  } catch {
    // not found
  }

  return candidates[0];
}

// ── Worker 管理 ──────────────────────────────────────────────────

function getAvailableWorker(): WorkerProcess | null {
  // 找空闲 worker
  const idle = workers.find((w) => !w.busy && w.process !== null);
  if (idle) return idle;

  // 没达到上限则创建新 worker
  if (workers.length < CONFIG.maxWorkers) {
    return createWorker();
  }

  return null;
}

function createWorker(): WorkerProcess {
  const id = nextWorkerId++;
  const worker: WorkerProcess = {
    id,
    process: null,
    busy: false,
    taskId: null,
    lastUsed: Date.now(),
    abortController: null,
  };
  workers.push(worker);
  log("info", `Worker created`, { workerId: id, totalWorkers: workers.length });
  return worker;
}

function assignTaskToWorker(worker: WorkerProcess, task: TaskState): void {
  worker.busy = true;
  worker.taskId = task.id;
  worker.lastUsed = Date.now();
  worker.abortController = new AbortController();

  const piPath = findPiPath();
  const args: string[] = ["--mode", "json", "-p", "--no-session"];

  // 添加 system prompt
  if (task.systemPrompt.trim()) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-"));
    const tmpFile = path.join(tmpDir, "prompt.md");
    fs.writeFileSync(tmpFile, task.systemPrompt, "utf-8");
    args.push("--append-system-prompt", tmpFile);
  }

  args.push(`Task: ${task.task}`);

  log("info", `Starting worker for task`, {
    workerId: worker.id,
    taskId: task.id,
    agent: task.agent,
    args: args.slice(0, 4).join(" "),
  });

  const isWindows = process.platform === "win32";
  const proc = spawn(
    isWindows ? "node" : piPath,
    isWindows ? [process.argv[1] || piPath, ...args] : args,
    {
      cwd: task.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  worker.process = proc;

  let stdoutBuffer = "";
  let isAborted = false;

  // 超时保护
  const timeout = setTimeout(() => {
    log("warn", `Task timeout`, { taskId: task.id, agent: task.agent });
    isAborted = true;
    task.aborted = true;
    task.errorMessage = "Task timed out";
    task.exitCode = 124;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 2000);
  }, CONFIG.taskTimeoutMs);

  // abort 信号
  const abortHandler = () => {
    if (isAborted) return;
    isAborted = true;
    task.aborted = true;
    task.errorMessage = "Task was cancelled";
    task.exitCode = -1;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 2000);
  };
  worker.abortController.signal.addEventListener("abort", abortHandler, { once: true });

  // 解析 stdout (JSONL 事件流)
  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.type === "message_end" && event.message) {
      const msg = event.message;
      task.messages.push(msg);

      if (msg.role === "assistant") {
        task.usage.turns++;
        const usage = msg.usage;
        if (usage) {
          task.usage.input += usage.input || 0;
          task.usage.output += usage.output || 0;
          task.usage.cacheRead += usage.cacheRead || 0;
          task.usage.cacheWrite += usage.cacheWrite || 0;
          task.usage.cost += usage.cost?.total || 0;
          task.usage.contextTokens = usage.totalTokens || 0;
        }
        if (!task.model && msg.model) task.model = msg.model;
        if (msg.stopReason) task.stopReason = msg.stopReason;
        if (msg.errorMessage) task.errorMessage = msg.errorMessage;
      }

      // 实时推送消息到客户端
      sendMessage({
        jsonrpc: "2.0",
        method: "message",
        params: { id: task.id, message: msg },
      });
    }

    if (event.type === "tool_result_end" && event.message) {
      task.messages.push(event.message);
      sendMessage({
        jsonrpc: "2.0",
        method: "message",
        params: { id: task.id, message: event.message },
      });
    }
  };

  proc.stdout.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) processLine(line);
  });

  proc.stderr.on("data", (data: Buffer) => {
    task.stderr += data.toString();
  });

  proc.on("close", (code) => {
    clearTimeout(timeout);
    if (stdoutBuffer.trim()) processLine(stdoutBuffer);

    task.exitCode = code ?? 0;
    task.workerId = worker.id;

    // 清理 worker 状态
    worker.busy = false;
    worker.taskId = null;
    worker.process = null;
    worker.lastUsed = Date.now();

    // 如果还有未处理的行，再处理一次
    const elapsed = ((Date.now() - task.startTime) / 1000).toFixed(1);
    log("info", `Task completed`, {
      taskId: task.id,
      agent: task.agent,
      exitCode: task.exitCode,
      elapsed: `${elapsed}s`,
      turns: task.usage.turns,
    });

    // 通知客户端
    sendMessage({
      jsonrpc: "2.0",
      id: task.id,
      result: {
        messages: task.messages,
        usage: task.usage,
        model: task.model,
        stopReason: task.stopReason,
        errorMessage: task.errorMessage,
        stderr: task.stderr,
        exitCode: task.exitCode,
        aborted: task.aborted,
      },
    });

    runningTasks.delete(task.id);
    const pending = pendingTasks.get(task.id);
    if (pending) {
      pending.resolve(task);
      pendingTasks.delete(task.id);
    }
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    log("error", `Worker process error`, { workerId: worker.id, taskId: task.id, error: err.message });

    task.exitCode = 1;
    task.errorMessage = err.message;
    task.workerId = worker.id;

    worker.busy = false;
    worker.taskId = null;
    worker.process = null;

    sendMessage({
      jsonrpc: "2.0",
      id: task.id,
      error: { code: -1, message: err.message },
    });

    runningTasks.delete(task.id);
    const pending = pendingTasks.get(task.id);
    if (pending) {
      pending.reject(err);
      pendingTasks.delete(task.id);
    }
  });
}

// ── 请求处理 ────────────────────────────────────────────────────

function handleExecuteRequest(req: JsonRpcRequest): void {
  const params = req.params as Record<string, unknown> | undefined;
  if (!params) {
    sendMessage({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: "Invalid params: missing params" },
    });
    return;
  }

  const taskId = typeof req.id === "string" ? req.id : String(req.id);

  const task: TaskState = {
    id: taskId,
    agent: String(params.agent || "worker"),
    task: String(params.task || ""),
    cwd: String(params.cwd || process.cwd()),
    systemPrompt: String(params.systemPrompt || ""),
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
    exitCode: -1,
    startTime: Date.now(),
    workerId: null,
    aborted: false,
  };

  const worker = getAvailableWorker();
  if (!worker) {
    // 所有 worker 都忙，排队
    log("info", `Task queued`, { taskId: task.id, agent: task.agent });
    // 通知客户端排队中
    sendMessage({
      jsonrpc: "2.0",
      method: "queued",
      params: { id: task.id, position: workers.filter((w) => w.busy).length },
    });

    // 轮询等待空闲 worker
    const tryAssign = () => {
      const w = getAvailableWorker();
      if (w) {
        assignTaskToWorker(w, task);
      } else {
        setTimeout(tryAssign, 100);
      }
    };
    tryAssign();
  } else {
    assignTaskToWorker(worker, task);
  }

  runningTasks.set(task.id, task);

  // 存储 promise 以便后续 resolve
  const promise = new Promise<TaskState>((resolve, reject) => {
    pendingTasks.set(task.id, { resolve, reject });
  });

  // 如果 task 已经完成（同步路径），直接返回
  // 否则通过 close handler 返回
}

function handleCancelRequest(req: JsonRpcRequest): void {
  const params = req.params as Record<string, unknown> | undefined;
  const cancelId = params?.id as string;
  if (!cancelId) {
    sendMessage({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: "Missing id param" },
    });
    return;
  }

  const task = runningTasks.get(cancelId);
  if (!task) {
    sendMessage({
      jsonrpc: "2.0",
      id: req.id,
      result: { cancelled: false, reason: "Task not found" },
    });
    return;
  }

  // 找到 worker 并 abort
  const worker = workers.find((w) => w.taskId === cancelId);
  if (worker && worker.abortController) {
    worker.abortController.abort();
  }

  sendMessage({
    jsonrpc: "2.0",
    id: req.id,
    result: { cancelled: true },
  });
}

function handleShutdownRequest(req: JsonRpcRequest): void {
  log("info", "Shutdown requested");

  // 终止所有 worker
  for (const worker of workers) {
    if (worker.process && !worker.process.killed) {
      worker.process.kill("SIGTERM");
    }
    if (worker.abortController) {
      worker.abortController.abort();
    }
  }

  sendMessage({
    jsonrpc: "2.0",
    id: req.id,
    result: { ok: true, workersTerminated: workers.length },
  });

  // 延迟退出，确保响应已发送
  setTimeout(() => {
    process.exit(0);
  }, 100);
}

function handleStatusRequest(req: JsonRpcRequest): void {
  const activeWorkers = workers.filter((w) => w.busy);
  const idleWorkers = workers.filter((w) => !w.busy);

  sendMessage({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      server: {
        uptime: process.uptime(),
        pid: process.pid,
      },
      workers: {
        total: workers.length,
        active: activeWorkers.length,
        idle: idleWorkers.length,
        max: CONFIG.maxWorkers,
      },
      tasks: {
        running: runningTasks.size,
        pending: pendingTasks.size,
      },
    },
  });
}

// ── 消息分发 ────────────────────────────────────────────────────

function handleMessage(line: string): void {
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(line);
  } catch {
    log("warn", "Malformed JSON-RPC message", { line: line.slice(0, 200) });
    return;
  }

  // 只处理请求 (有 id 且有 method)
  if ("method" in msg && "id" in msg) {
    const req = msg as JsonRpcRequest;
    switch (req.method) {
      case "execute":
        handleExecuteRequest(req);
        break;
      case "cancel":
        handleCancelRequest(req);
        break;
      case "shutdown":
        handleShutdownRequest(req);
        break;
      case "status":
        handleStatusRequest(req);
        break;
      default:
        sendMessage({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        });
    }
  }
}

// ── 启动 ──────────────────────────────────────────────────────────

function start(): void {
  if (serverStarted) return;
  serverStarted = true;

  log("info", "Subagent server starting", {
    pid: process.pid,
    nodeVersion: process.version,
    platform: process.platform,
    maxWorkers: CONFIG.maxWorkers,
  });

  // 通知客户端服务器已就绪
  sendMessage({
    jsonrpc: "2.0",
    method: "server_ready",
    params: {
      pid: process.pid,
      maxWorkers: CONFIG.maxWorkers,
      version: "1.0.0",
    },
  });

  // 从 stdin 读取 JSON-RPC 消息
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", handleMessage);

  rl.on("close", () => {
    log("info", "stdin closed, shutting down");
    // 终止所有 worker
    for (const worker of workers) {
      if (worker.process && !worker.process.killed) {
        worker.process.kill("SIGTERM");
      }
    }
    process.exit(0);
  });

  // 优雅退出
  process.on("SIGTERM", () => {
    log("info", "Received SIGTERM");
    for (const worker of workers) {
      if (worker.process && !worker.process.killed) {
        worker.process.kill("SIGTERM");
      }
    }
    process.exit(0);
  });

  process.on("SIGINT", () => {
    log("info", "Received SIGINT");
    for (const worker of workers) {
      if (worker.process && !worker.process.killed) {
        worker.process.kill("SIGTERM");
      }
    }
    process.exit(0);
  });

  // 空闲 worker 回收
  setInterval(() => {
    const now = Date.now();
    for (const worker of workers) {
      if (!worker.busy && worker.process === null && (now - worker.lastUsed) > CONFIG.workerIdleTimeoutMs) {
        const idx = workers.indexOf(worker);
        if (idx !== -1) {
          workers.splice(idx, 1);
          log("info", "Recycled idle worker", { workerId: worker.id });
        }
      }
    }
  }, 60_000); // 每分钟检查一次
}

// 启动
start();