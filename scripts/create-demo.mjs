import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sample = "public/examples/scout-plan-project/";
const sampleFiles = [
  "package.json", "README.md", "TASK.md", "src/catalog.mjs", "src/cli.mjs",
  "data/books.json", "test/catalog.test.mjs",
];
const extensionFiles = ["index.ts", "agents.ts", "subagent-client.ts", "subagent-server.ts", "subagent-process.ts"];

function parseArgs(args) {
  const result = { output: ".local-audit/scout-plan-demo" };
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--help") return { help: true };
    if (!["--output", "--model"].includes(option) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error("invalid_arguments");
    }
    result[option.slice(2)] = args[++index];
  }
  if (result.model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(result.model)) {
    throw new Error("invalid_model_identifier");
  }
  return result;
}

function nearestExistingParent(target) {
  let current = path.dirname(target);
  while (!fs.existsSync(current)) current = path.dirname(current);
  return fs.realpathSync(current);
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/create-demo.mjs [--output <new-directory>] [--model <provider/model>]");
    return;
  }
  const target = path.resolve(root, options.output);
  if (fs.existsSync(target)) throw new Error("output_exists_no_overwrite");
  const parent = nearestExistingParent(target);
  const relativeParent = path.relative(fs.realpathSync(root), parent);
  const relativeTarget = path.relative(root, target);
  if (!relativeTarget || relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget) ||
      relativeParent.startsWith("..") || path.isAbsolute(relativeParent) ||
      relativeTarget.split(path.sep).some((part) => [".git", "public", "docs", "scripts"].includes(part))) {
    throw new Error("output_must_be_new_directory_within_repository");
  }

  const copies = sampleFiles.map((name) => [sample + name, name]);
  for (const name of extensionFiles) copies.push(["public/extensions/subagent/" + name, ".pi/extensions/subagent/" + name]);
  for (const name of ["scout", "planner"]) copies.push(["public/agents/" + name + ".md", ".pi/agents/" + name + ".md"]);
  copies.push(["public/prompts/scout-and-plan.md", ".pi/prompts/scout-and-plan.md"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "public/manifest.json"), "utf8"));
  const allowed = new Set(manifest.files.map((entry) => entry.path));
  // Read all explicit sources before creating output. No recursive workspace copy.
  const contents = copies.map(([source, destination]) => {
    if (!allowed.has(source)) throw new Error("source_not_in_public_manifest");
    const sourcePath = path.join(root, source);
    if (fs.lstatSync(sourcePath).isSymbolicLink()) throw new Error("source_symlink_rejected");
    let data = fs.readFileSync(sourcePath);
    if (options.model && destination.startsWith(".pi/agents/")) {
      data = Buffer.from(data.toString("utf8").replace(/^---\r?\n/, `---\nmodel: ${options.model}\n`));
    }
    return { source, destination, data };
  });
  fs.mkdirSync(target, { recursive: true });
  const records = [];
  for (const { source, destination, data } of contents) {
    const outputPath = path.join(target, destination);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, data, { flag: "wx" });
    records.push({ source, path: destination, sha256: sha256(data) });
  }
  // The acceptance rubric is intentionally kept outside the agent's workspace.
  fs.writeFileSync(path.join(target, ".gitignore"), ".pi/\n.demo-manifest.json\n", { flag: "wx" });
  fs.writeFileSync(path.join(target, ".demo-manifest.json"), JSON.stringify({
    schema_version: 1, validation_scope: "offline preparation only", files: records,
  }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ status: "created", path: relativeTarget.split(path.sep).join("/"), copiedFiles: records.length, modelCalls: 0 }));
}

try { main(); }
catch (error) {
  const category = /^[a-z_]+$/.test(error.message) ? error.message : "demo_creation_failed";
  console.error(JSON.stringify({ category, recommendation: "Use a new directory; existing files are retained." }));
  process.exitCode = 1;
}
