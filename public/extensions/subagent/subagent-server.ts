/**
 * Subagent Server — 常驻守护进程
 *
 * 借鉴 OpenAI Codex exec-server 架构:
 * - JSON-RPC over stdio 双向通信
 * - 调度槽位管理，每个任务启动独立 Pi 进程
 * - 流式输出实时推送
 * - 完整进程生命周期控制
 *
 * 启动方式: node subagent-server.ts
 * 通信协议: stdin/stdout 走 JSON-RPC 2.0 (每行一个 JSON 对象)
 */

import * as readline from "node:readline";
import { getPiInvocation, runPiProcess, TASK_TIMEOUT_MS, type PiInvocation, type ProcessResult, type ProcessTask } from "./subagent-process.ts";

type RequestId = string | number;
interface JsonRpcRequest { jsonrpc: "2.0"; id: RequestId; method: string; params?: Record<string, unknown>; }
interface TaskState { id: RequestId; agent: string; parameters: ProcessTask; controller: AbortController; }
interface WorkerSlot { id: number; busy: boolean; task?: TaskState; promise?: Promise<void>; }

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
function positive(value: string | undefined, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid service limit");
  return number;
}
const maxWorkers = positive(option("--max-workers"), 4);
if (maxWorkers > 4) throw new Error("At most four workers are supported");
const taskTimeoutMs = positive(option("--task-timeout-ms"), TASK_TIMEOUT_MS);
const configuredInvocation = option("--pi-invocation");
const invocation: PiInvocation = configuredInvocation ? JSON.parse(configuredInvocation) : getPiInvocation();
if (!invocation || typeof invocation.command !== "string" || !Array.isArray(invocation.args) || invocation.args.some((arg) => typeof arg !== "string")) {
  throw new Error("Invalid Pi invocation");
}
const workers: WorkerSlot[] = [];
const tasks = new Map<RequestId, TaskState>();
const queue: TaskState[] = [];
let stopping = false;
let shutdownPromise: Promise<void> | undefined;
let closed = false;

function sendMessage(message: unknown): void {
  if (!process.stdout.destroyed && !process.stdout.writableEnded) process.stdout.write(JSON.stringify(message) + "\n");
}
function emptyResult(reason: string): ProcessResult {
  return {
    messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    stderr: "", exitCode: 130, aborted: true, stopReason: "aborted", errorMessage: reason,
  };
}
function finishTask(task: TaskState, result: ProcessResult): void {
  tasks.delete(task.id);
  sendMessage({ jsonrpc: "2.0", id: task.id, result });
}
function getAvailableWorker(): WorkerSlot | undefined {
  const idle = workers.find((worker) => !worker.busy);
  if (idle) return idle;
  if (workers.length === maxWorkers) return;
  const worker = { id: workers.length + 1, busy: false };
  workers.push(worker);
  return worker;
}
function pumpQueue(): void {
  while (!stopping && queue.length) {
    const worker = getAvailableWorker();
    if (!worker) return;
    const task = queue.shift()!;
    worker.busy = true;
    worker.task = task;
    worker.promise = (async () => {
      let result: ProcessResult;
      try {
        result = await runPiProcess(invocation, task.parameters, task.controller.signal, (message) => {
          sendMessage({ jsonrpc: "2.0", method: "message", params: { id: task.id, message } });
        }, taskTimeoutMs);
      } catch (error) {
        result = { ...emptyResult("Subagent execution or cleanup failed"), exitCode: 1, aborted: false, stopReason: "error" };
      }
      worker.busy = false;
      worker.task = undefined;
      finishTask(task, result);
      pumpQueue();
    })();
  }
}
function validId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
function errorResponse(id: RequestId | null, code: number, message: string): void {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
}
function handleExecuteRequest(request: JsonRpcRequest): void {
  if (stopping) { errorResponse(request.id, -32000, "Service is shutting down"); return; }
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.task !== "string" || !params.task.trim() ||
      (params.cwd !== undefined && typeof params.cwd !== "string") ||
      (params.systemPrompt !== undefined && typeof params.systemPrompt !== "string") ||
      (params.model !== undefined && typeof params.model !== "string") ||
      (params.tools !== undefined && (!Array.isArray(params.tools) || params.tools.some((tool) => typeof tool !== "string")))) {
    errorResponse(request.id, -32602, "Invalid task parameters"); return;
  }
  if (tasks.has(request.id)) { errorResponse(request.id, -32600, "Duplicate task request ID"); return; }
  const task: TaskState = {
    id: request.id, agent: typeof params.agent === "string" ? params.agent : "worker", controller: new AbortController(),
    parameters: {
      task: params.task, cwd: (params.cwd as string | undefined) ?? process.cwd(),
      systemPrompt: (params.systemPrompt as string | undefined) ?? "", model: params.model as string | undefined,
      tools: params.tools as string[] | undefined,
    },
  };
  tasks.set(task.id, task);
  queue.push(task);
  pumpQueue();
  if (queue.includes(task)) sendMessage({ jsonrpc: "2.0", method: "queued", params: { id: task.id, position: queue.indexOf(task) + 1 } });
}
function handleCancelRequest(request: JsonRpcRequest): void {
  const id = request.params?.id;
  if (!validId(id)) { errorResponse(request.id, -32602, "Missing task ID"); return; }
  const task = tasks.get(id);
  if (!task) { sendMessage({ jsonrpc: "2.0", id: request.id, result: { cancelled: false } }); return; }
  const position = queue.indexOf(task);
  if (position !== -1) {
    queue.splice(position, 1);
    finishTask(task, emptyResult("Queued subagent was aborted"));
  } else task.controller.abort();
  sendMessage({ jsonrpc: "2.0", id: request.id, result: { cancelled: true } });
}
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  for (const task of queue.splice(0)) finishTask(task, emptyResult("Subagent cancelled during shutdown"));
  for (const worker of workers) worker.task?.controller.abort();
  shutdownPromise = Promise.allSettled(workers.map((worker) => worker.promise)).then(() => {});
  return shutdownPromise;
}
const input = readline.createInterface({ input: process.stdin, terminal: false });
function closeServer(): void {
  if (closed) return;
  closed = true;
  input.close();
  process.stdin.destroy();
  process.stdout.end();
}
function handleMessage(line: string): void {
  let request: JsonRpcRequest;
  try { request = JSON.parse(line); } catch { errorResponse(null, -32700, "Invalid JSON"); return; }
  if (!request || typeof request !== "object" || request.jsonrpc !== "2.0" || !validId(request.id) || typeof request.method !== "string") {
    errorResponse(null, -32600, "Invalid request"); return;
  }
  switch (request.method) {
    case "execute": handleExecuteRequest(request); break;
    case "cancel": handleCancelRequest(request); break;
    case "status":
      sendMessage({ jsonrpc: "2.0", id: request.id, result: {
        server: { uptime: process.uptime(), pid: process.pid },
        workers: { total: workers.length, active: workers.filter((worker) => worker.busy).length, idle: workers.filter((worker) => !worker.busy).length, max: maxWorkers },
        tasks: { running: workers.filter((worker) => worker.busy).length, pending: queue.length },
      } });
      break;
    case "shutdown":
      void shutdown().then(() => {
        sendMessage({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
        closeServer();
      });
      break;
    default: errorResponse(request.id, -32601, "Unknown method");
  }
}
input.on("line", handleMessage);
input.on("close", () => { void shutdown().then(closeServer); });
process.on("SIGTERM", () => { void shutdown().then(closeServer); });
process.on("SIGINT", () => { void shutdown().then(closeServer); });
process.stdout.on("error", () => { void shutdown().then(closeServer); });
sendMessage({ jsonrpc: "2.0", method: "server_ready", params: { pid: process.pid, maxWorkers, version: "1.1.0" } });
