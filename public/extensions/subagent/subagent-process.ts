/** Shared Pi launch, JSONL parsing, cancellation and temporary-file cleanup. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";

export interface PiInvocation { command: string; args: string[]; }
export interface UsageStats {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cost: number; contextTokens: number; turns: number;
}
export interface ProcessResult {
  messages: Message[]; usage: UsageStats; model?: string; stopReason?: string;
  errorMessage?: string; stderr: string; exitCode: number; aborted?: boolean;
}
export interface ProcessTask { task: string; systemPrompt: string; cwd: string; model?: string; tools?: string[]; }
export const TASK_TIMEOUT_MS = 5 * 60 * 1000;

function cliFromPackage(directory: string): string | undefined {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    if (metadata.name !== "@earendil-works/pi-coding-agent") return;
    const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.pi;
    if (typeof bin !== "string") return;
    const cli = path.resolve(directory, bin);
    if (fs.existsSync(cli) && /\.[cm]?js$/.test(cli)) return cli;
  } catch { /* This candidate is not an installed Pi package. */ }
}

function cliNearFile(file: string): string | undefined {
  try {
    let directory = path.dirname(fs.realpathSync(file));
    while (true) {
      const cli = cliFromPackage(directory);
      if (cli) return cli;
      const parent = path.dirname(directory);
      if (parent === directory) return;
      directory = parent;
    }
  } catch { /* Missing candidate. */ }
}

export function getPiInvocation(args: string[] = []): PiInvocation {
  const configured = process.env.PI_SUBAGENT_PI_PATH;
  if (configured) {
    if (!path.isAbsolute(configured) || !/\.[cm]?js$/.test(configured) || !fs.existsSync(configured)) {
      throw new Error("PI_SUBAGENT_PI_PATH must name an existing absolute Pi CLI JavaScript file");
    }
    return { command: process.execPath, args: [configured, ...args] };
  }
  const candidates: string[] = [];
  if (process.argv[1]) candidates.push(process.argv[1]);
  try { candidates.push(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent")); }
  catch { /* Pi's loader may map modules without a physical local package. */ }
  for (const file of candidates) {
    const cli = cliNearFile(file);
    if (cli) return { command: process.execPath, args: [cli, ...args] };
  }
  if (process.env.PI_PACKAGE_DIR) {
    const cli = cliFromPackage(process.env.PI_PACKAGE_DIR);
    if (cli) return { command: process.execPath, args: [cli, ...args] };
  }
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const cli = cliFromPackage(path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent"));
    if (cli) return { command: process.execPath, args: [cli, ...args] };
    const linked = cliNearFile(path.join(directory, "pi"));
    if (linked) return { command: process.execPath, args: [linked, ...args] };
  }
  throw new Error("Cannot locate the installed Pi CLI; set PI_SUBAGENT_PI_PATH to its CLI JavaScript file");
}

/** Only call with a child owned by this module or the service manager. */
export function terminateChild(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const command = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "taskkill.exe") : "taskkill.exe";
    const killed = spawnSync(command, ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    if (!killed.error && killed.status === 0) return;
    child.kill("SIGKILL");
  } else {
    try { process.kill(-child.pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGTERM"); }
  }
}

export async function runPiProcess(
  invocation: PiInvocation, task: ProcessTask, signal?: AbortSignal,
  onMessage?: (message: Message, progress: ProcessResult) => void, timeoutMs = TASK_TIMEOUT_MS,
): Promise<ProcessResult> {
  const result: ProcessResult = {
    messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: task.model, stderr: "", exitCode: 1,
  };
  if (signal?.aborted) return { ...result, aborted: true, exitCode: 130, stopReason: "aborted", errorMessage: "Subagent was aborted" };
  let promptDirectory: string | undefined;
  let promptFile: string | undefined;
  try {
    const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
    if (task.model) args.push("--model", task.model);
    if (task.tools) {
      if (task.tools.length) args.push("--tools", task.tools.join(","));
      else args.push("--no-tools");
    }
    if (task.systemPrompt.trim()) {
      promptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
      promptFile = path.join(promptDirectory, "prompt.md");
      fs.writeFileSync(promptFile, task.systemPrompt, { encoding: "utf8", mode: 0o600 });
      args.push("--append-system-prompt", promptFile);
    }
    args.push(`Task: ${task.task}`);
    await new Promise<void>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(invocation.command, [...invocation.args, ...args], {
          cwd: task.cwd, shell: false, windowsHide: true,
          detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        result.errorMessage = `Failed to launch subagent (${(error as NodeJS.ErrnoException).code || "spawn"})`;
        resolve();
        return;
      }
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let finished = false;
      let launchFailed = false;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const stop = (timedOut = false) => {
        if (finished || result.aborted) return;
        result.aborted = true;
        result.exitCode = timedOut ? 124 : 130;
        result.stopReason = "aborted";
        result.errorMessage = timedOut ? "Subagent timed out" : "Subagent was aborted";
        terminateChild(child);
        forceKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            if (process.platform !== "win32" && child.pid) {
              try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
            } else child.kill("SIGKILL");
          }
        }, 2000);
        forceKill.unref();
      };
      const abort = () => stop();
      const timeout = setTimeout(() => stop(true), timeoutMs);
      const processLine = (line: string) => {
        let event: any;
        try { event = JSON.parse(line); } catch { return; }
        if (!event || !["message_end", "tool_result_end"].includes(event.type) || !event.message) return;
        const message = event.message as Message;
        result.messages.push(message);
        if (message.role === "assistant") {
          result.usage.turns++;
          const usage = (message as any).usage;
          if (usage) {
            for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) result.usage[field] += usage[field] || 0;
            result.usage.cost += usage.cost?.total || 0;
            result.usage.contextTokens = usage.totalTokens || 0;
          }
          result.model = (message as any).model || result.model;
          if (!result.aborted) result.stopReason = (message as any).stopReason;
          if ((message as any).errorMessage) result.errorMessage = (message as any).errorMessage;
        }
        try { onMessage?.(message, result); }
        catch { stop(); result.errorMessage = "Subagent progress callback failed"; }
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      child.stderr!.on("data", (chunk: Buffer) => { result.stderr += chunk.toString(); });
      child.on("error", (error: NodeJS.ErrnoException) => {
        launchFailed = true;
        result.errorMessage = `Failed to launch subagent (${error.code || "spawn"})`;
      });
      child.on("close", (code) => {
        finished = true;
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        signal?.removeEventListener("abort", abort);
        buffer += decoder.end();
        if (buffer.trim()) processLine(buffer);
        if (!result.aborted) result.exitCode = launchFailed ? 1 : code ?? 1;
        if (result.exitCode !== 0 && !result.stopReason) result.stopReason = "error";
        resolve();
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    return result;
  } finally {
    // Remove only the exact temporary files created for this invocation.
    for (const [target, remove] of [[promptFile, fs.unlinkSync], [promptDirectory, fs.rmdirSync]] as const) {
      if (!target) continue;
      try { remove(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          result.exitCode = 1;
          result.stopReason = "error";
          result.errorMessage = "Temporary subagent prompt cleanup failed";
        }
      }
    }
  }
}
