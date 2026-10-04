// Synthetic JSONL child for transport tests. This is not Pi or a model provider.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.argv.includes("--fixture-descendant")) {
  setInterval(() => {}, 1000);
} else {
  const args = process.argv.slice(2);
  const task = args.find((arg) => arg.startsWith("Task: "))?.slice(6) || "echo";
  fs.appendFileSync(path.join(process.cwd(), "synthetic-starts.jsonl"), JSON.stringify({ task }) + "\n");
  if (task === "silent") process.exit(0);
  const option = (name) => args[args.indexOf(name) + 1];
  const promptPath = args.includes("--append-system-prompt") ? option("--append-system-prompt") : undefined;
  const data = {
    task, pid: process.pid, cwd: process.cwd(), args,
    prompt: promptPath ? fs.readFileSync(promptPath, "utf8") : "",
    promptPath, unicode: "状态",
  };
  if (task === "spawn-child") {
    const child = spawn(process.execPath, [process.argv[1], "--fixture-descendant"], { stdio: "ignore" });
    data.childPid = child.pid;
    fs.writeFileSync(path.join(process.cwd(), "synthetic-descendant.pid"), String(child.pid));
  }
  const message = {
    type: "message_end",
    message: {
      role: "assistant", content: [{ type: "text", text: JSON.stringify(data) }],
      model: args.includes("--model") ? option("--model") : "synthetic",
      stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
    },
  };
  const output = Buffer.from(JSON.stringify(message) + "\n");
  // Deliberately split a multibyte character across stdout chunks.
  const split = output.indexOf(Buffer.from("状")) + 1;
  process.stdout.write(output.subarray(0, split));
  setTimeout(() => {
    process.stdout.write(output.subarray(split));
    if (task === "hang" || task === "spawn-child") setInterval(() => {}, 1000);
    else if (task === "crash") process.exitCode = 7;
  }, 10);
}
