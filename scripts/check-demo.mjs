import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sample = "public/examples/scout-plan-project/";
const sourceFiles = [
  "package.json", "README.md", "TASK.md", "src/catalog.mjs", "src/cli.mjs",
  "data/books.json", "test/catalog.test.mjs",
];
const generatedFiles = [
  ...sourceFiles,
  ...["index.ts", "agents.ts", "subagent-client.ts", "subagent-server.ts"].map((name) => ".pi/extensions/subagent/" + name),
  ".pi/agents/scout.md", ".pi/agents/planner.md", ".pi/prompts/scout-and-plan.md",
];

function hash(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node scripts/check-demo.mjs [--project <generated-directory>]");
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== "--project" || !args[1])) throw new Error("invalid_arguments");
  const project = path.resolve(root, args[1] || ".local-audit/scout-plan-demo");
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(project));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("project_must_be_within_repository");
  const manifest = JSON.parse(fs.readFileSync(path.join(project, ".demo-manifest.json"), "utf8"));
  if (manifest.schema_version !== 1 || manifest.validation_scope !== "offline preparation only") throw new Error("invalid_demo_manifest");
  const paths = manifest.files.map((entry) => entry.path).sort();
  if (JSON.stringify(paths) !== JSON.stringify([...generatedFiles].sort())) throw new Error("unexpected_demo_file_list");
  for (const entry of manifest.files) {
    const file = path.join(project, entry.path);
    if (fs.lstatSync(file).isSymbolicLink() || hash(fs.readFileSync(file)) !== entry.sha256) throw new Error("generated_file_changed_review_required");
    // Check sample source against the public fixture as well as the generated baseline.
    if (sourceFiles.includes(entry.path) && hash(fs.readFileSync(path.join(root, sample + entry.path))) !== entry.sha256) {
      throw new Error("sample_differs_from_public_fixture");
    }
  }
  const tests = spawnSync(process.execPath, ["--test", "test/catalog.test.mjs"], { cwd: project, encoding: "utf8" });
  if (tests.error || tests.status !== 0) throw new Error("sample_baseline_tests_failed");
  const cli = spawnSync(process.execPath, ["src/cli.mjs", "--status", "reading"], { cwd: project, encoding: "utf8" });
  if (cli.error || cli.status !== 0 || cli.stdout.trim().split(/\r?\n/).map((line) => line.split("\t")[0]).join(",") !== "book-002,book-004") {
    throw new Error("sample_cli_baseline_failed");
  }
  const invalid = spawnSync(process.execPath, ["src/cli.mjs", "--status", "invalid"], { cwd: project, encoding: "utf8" });
  if (invalid.error || invalid.status !== 2) throw new Error("sample_cli_invalid_input_failed");
  for (const agent of ["scout", "planner"]) {
    const definition = fs.readFileSync(path.join(project, ".pi/agents/" + agent + ".md"), "utf8");
    if (!definition.startsWith("---\n") || !definition.includes("name: " + agent)) throw new Error("agent_definition_invalid");
  }
  const prompt = fs.readFileSync(path.join(project, ".pi/prompts/scout-and-plan.md"), "utf8");
  if (!prompt.includes('agentScope: "project"') || !prompt.includes("{previous}") || !prompt.includes("$@")) throw new Error("prompt_handoff_invalid");
  console.log(JSON.stringify({ status: "passed", scope: "offline fixture, copy integrity, agent/prompt structure", generatedFiles: paths.length, sampleBaselineTests: 4, modelCalls: 0, realWorkflowValidated: false }));
}

try { main(); }
catch (error) {
  const category = /^[a-z_]+$/.test(error.message) ? error.message : "demo_check_failed";
  console.error(JSON.stringify({ category, recommendation: "Inspect the isolated demo; do not treat this check as model validation." }));
  process.exitCode = 1;
}
