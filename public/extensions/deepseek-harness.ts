import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * DeepSeek execution harness for Pi — v4 (memory-aware + skill-learning).
 *
 * v4 changes (Hermes Agent integration inspired):
 * - Persistent Memory: cross-session pattern learning, stored in memory/ directory.
 * - Skills System: auto-learns successful edit→verify→pass patterns as reusable skills.
 * - File Knowledge Graph: tracks file roles, reduces re-reads across sessions.
 * - Session Summarization: writes compact summary to memory for future sessions.
 * - Memory-Aware Prompting: injects relevant past patterns and skill matches.
 * - Adaptive Auto-Tuning: tunes exploration/error limits based on historical success rate.
 *
 * v3 foundations preserved:
 * - Phase detection (explore → edit → verify → done)
 * - Token budget tracking
 * - Verification result awareness
 * - Exponential error backoff
 * - Task complexity estimation
 */

// ── Configuration ──────────────────────────────────────────────────

const CONFIG = {
  maxIdenticalToolCalls: 2,
  maxExploreStreak: 6,
  maxExploreStreakHard: 14,
  maxReadLines: 500,
  maxToolResultChars: 16_000,
  maxConsecutiveErrors: 3,
  telemetryFile: ".pi/deepseek-harness/events.jsonl",
  memoryDir: ".pi/deepseek-harness/memory",
  skillsDir: ".pi/deepseek-harness/skills",
  autoLearnThreshold: 5,          // sessions before auto-tuning kicks in
  skillMinMatches: 2,             // how many times a pattern must succeed to become a skill
  maxMemorySkills: 20,            // max skills to keep
  maxMemoryPatterns: 50,          // max patterns in memory
  maxFailedPatterns: 20,          // max failed patterns to keep
  maxProjectContexts: 10,         // max cached project contexts
  toolEffectivenessMinSamples: 5, // min samples before tool hints appear

  // Token budget
  maxExplorationChars: 80_000,
  maxTotalChars: 300_000,

  protectedPathFragments: [
    ".env", ".git/", "node_modules/", ".ssh/", "credentials",
    "secrets", "id_rsa", "id_ed25519", "*.pem", "*.key",
  ],

  // SubAgent
  subagentTimeoutMs: 5 * 60 * 1000,
  subagentRetryCount: 1,

  // Archetype detection priority order
  archetypeDetectors: [
    "minecraft-plugin",
    "web-app",
    "python-project",
    "data-science",
    "node-library",
  ] as ProjectArchetype[],
};

// ── Types ──────────────────────────────────────────────────────────

type AgentPhase = "init" | "explore" | "edit" | "verify" | "done" | "stuck";

type TaskComplexity = "simple" | "moderate" | "complex";

type ProjectArchetype =
  | "minecraft-plugin"
  | "web-app"
  | "node-library"
  | "python-project"
  | "data-science"
  | "unknown";

type FailureCategory = "syntax" | "type" | "test" | "lint" | "runtime" | "unknown";

type ToolTaskType = "read-config" | "verify-test" | "verify-type" | "verify-lint" | "explore" | "edit" | "unknown";

interface ToolStats {
  identicalCalls: Map<string, number>;
  exploreStreak: number;
  productiveReads: number;
  reReads: number;
  edits: number;
  verifications: number;
  successfulVerifications: number;
  errors: number;
  consecutiveErrors: number;
  readHistory: Set<string>;
  lastErrorTool: string;
  sessionCount: number;
  lastBlockReason: string;

  // Phase tracking
  phase: AgentPhase;
  phaseStartEditCount: number;

  // Token budget tracking
  totalExplorationChars: number;
  totalReadChars: number;
  totalWrittenChars: number;
  lastVerificationPassed: boolean | null;
  lastVerificationOutput: string;

  // Task metadata
  taskGoal: string;
  taskComplexity: TaskComplexity;
  startedAt: number;

  // v4: Memory & skills
  sessionMemory: SessionMemory;
  matchedSkills: LearnedSkill[];
  currentEditPattern: EditPattern | null;
  editPatterns: EditPattern[];
  verificationResults: VerificationResult[];

  // v4: File knowledge graph (cross-session)
  fileKnowledge: Map<string, FileKnowledge>;

  // v5: Project archetype & context
  projectArchetype: ProjectArchetype;
  projectContext: ProjectContext | null;

  // v5: Tool effectiveness tracking
  toolEffectiveness: Map<string, ToolEffectivenessEntry>;
}

// ── Memory types ───────────────────────────────────────────────────

interface EditPattern {
  description: string;           // what the edit did
  files: string[];              // files touched
  explorationContext: string;   // what was explored before editing
  verificationCommand: string;  // what command was used to verify
  verificationPassed: boolean;
  timestamp: number;
  sessionId: number;
  complexity: TaskComplexity;
  frequency: number;            // how many times this pattern was used
  successRate: number;          // 0.0 - 1.0

  // v5: Failure learning
  failureReason?: string;        // why it failed (e.g., "SyntaxError: unexpected token")
  failureCategory?: FailureCategory;
}

interface VerificationResult {
  command: string;
  passed: boolean;
  outputSummary: string;        // first 200 chars of output
  timestamp: number;
  editsBefore: number;

  // v5: Failure classification
  failureCategory?: FailureCategory;
}

interface FileKnowledge {
  path: string;
  role: string;                 // "config", "source", "test", "doc", "data", "unknown"
  firstSeen: number;            // session id
  lastSeen: number;             // session id
  accessCount: number;
  description: string;          // human-readable summary of what this file does
}

// v5: Project archetype context
interface ProjectContext {
  projectRoot: string;
  archetype: ProjectArchetype;
  lastHandoffPath?: string;      // path to LATEST.md/handoff file
  architectureNotes: string[];   // key architecture insights
  lastSessionId: number;
  detectedAt: number;
}

// v5: Tool effectiveness tracking
interface ToolEffectivenessEntry {
  toolName: string;
  taskType: ToolTaskType;
  successCount: number;
  failCount: number;
  lastUsed: number;
}

// v5: Failure pattern for learning
interface FailurePattern {
  description: string;
  failureCategory: FailureCategory;
  failureReason: string;
  files: string[];
  verificationCommand: string;
  timestamp: number;
  sessionId: number;
  frequency: number;
}

interface LearnedSkill {
  name: string;
  description: string;
  trigger: string;              // pattern to match against task description
  steps: string[];              // suggested steps
  files: string[];              // common files involved
  verificationHint: string;     // how to verify
  successCount: number;
  failCount: number;
  createdAt: number;
  lastUsedAt: number;
  complexity: TaskComplexity;
}

interface SessionMemory {
  patterns: EditPattern[];
  skills: LearnedSkill[];
  fileKnowledge: FileKnowledge[];
  sessionSummaries: SessionSummary[];

  // v5: Cross-session project state
  projectContexts: Record<string, ProjectContext>;

  // v5: Failure patterns
  failurePatterns: FailurePattern[];

  // v5: Tool effectiveness
  toolEffectiveness: ToolEffectivenessEntry[];
}

interface SessionSummary {
  sessionId: number;
  goal: string;
  complexity: TaskComplexity;
  phase: AgentPhase;
  edits: number;
  verifications: number;
  passed: boolean;
  elapsedSeconds: number;
  filesTouched: string[];
  keyInsight: string;           // what was learned
  errors: number;
  timestamp: number;
}

// ── State ──────────────────────────────────────────────────────────

let stats = freshStats();

function freshStats(): ToolStats {
  return {
    identicalCalls: new Map(),
    exploreStreak: 0,
    productiveReads: 0,
    reReads: 0,
    edits: 0,
    verifications: 0,
    successfulVerifications: 0,
    errors: 0,
    consecutiveErrors: 0,
    readHistory: new Set(),
    lastErrorTool: "",
    sessionCount: 0,
    lastBlockReason: "",
    phase: "init",
    phaseStartEditCount: 0,
    totalExplorationChars: 0,
    totalReadChars: 0,
    totalWrittenChars: 0,
    lastVerificationPassed: null,
    lastVerificationOutput: "",
    taskGoal: "",
    taskComplexity: "moderate",
    startedAt: Date.now(),
    sessionMemory: {
      patterns: [],
      skills: [],
      fileKnowledge: [],
      sessionSummaries: [],
      projectContexts: {},
      failurePatterns: [],
      toolEffectiveness: [],
    },
    matchedSkills: [],
    currentEditPattern: null,
    editPatterns: [],
    verificationResults: [],
    fileKnowledge: new Map(),

    // v5: Project archetype & context
    projectArchetype: "unknown",
    projectContext: null,

    // v5: Tool effectiveness
    toolEffectiveness: new Map(),
  };
}

// ── Memory Persistence ─────────────────────────────────────────────

function memoryDir(): string {
  const local = resolve(process.cwd(), CONFIG.memoryDir);
  // Use project-local .pi/ if it exists, otherwise fall back to global
  if (existsSync(resolve(process.cwd(), ".pi"))) {
    return local;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return resolve(home, "pi", "deepseek-harness", "memory");
}

function skillsDir(): string {
  const local = resolve(process.cwd(), CONFIG.skillsDir);
  if (existsSync(resolve(process.cwd(), ".pi"))) {
    return local;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return resolve(home, "pi", "deepseek-harness", "skills");
}

function telemetryFilePath(): string {
  const local = resolve(process.cwd(), CONFIG.telemetryFile);
  if (existsSync(resolve(process.cwd(), ".pi"))) {
    return local;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return resolve(home, "pi", "deepseek-harness", "events.jsonl");
}

function ensureDirs() {
  mkdirSync(memoryDir(), { recursive: true });
  mkdirSync(skillsDir(), { recursive: true });
}

function memoryFilePath(): string {
  return resolve(memoryDir(), "memory.json");
}

function loadMemory(): SessionMemory {
  ensureDirs();
  const path = memoryFilePath();
  try {
    if (!existsSync(path)) {
      return {
        patterns: [], skills: [], fileKnowledge: [], sessionSummaries: [],
        projectContexts: {}, failurePatterns: [], toolEffectiveness: [],
      };
    }
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);

    // Ensure backward compatibility with v3/v4 memory (empty fields)
    return {
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      fileKnowledge: Array.isArray(parsed.fileKnowledge) ? parsed.fileKnowledge : [],
      sessionSummaries: Array.isArray(parsed.sessionSummaries) ? parsed.sessionSummaries : [],
      // v5: Cross-session & failure & tool tracking
      projectContexts: parsed.projectContexts ?? {},
      failurePatterns: Array.isArray(parsed.failurePatterns) ? parsed.failurePatterns : [],
      toolEffectiveness: Array.isArray(parsed.toolEffectiveness) ? parsed.toolEffectiveness : [],
    };
  } catch {
    return { patterns: [], skills: [], fileKnowledge: [], sessionSummaries: [] };
  }
}

function saveMemory(memory: SessionMemory) {
  ensureDirs();
  try {
    writeFileSync(memoryFilePath(), JSON.stringify(memory, null, 2), "utf8");
  } catch {
    // Memory must never break the agent.
  }
}

function loadSkillsFromDisk(): LearnedSkill[] {
  ensureDirs();
  const dir = skillsDir();
  try {
    const files = readFileSync(dir, "utf8") ? [] : []; // will use fs.readdirSync
    // Actually, we store skills embedded in memory.json for simplicity.
    // Skills dir is for future extension (individual skill files).
    return [];
  } catch {
    return [];
  }
}

// ── Skill Learning ─────────────────────────────────────────────────

function extractEditPattern(stats: ToolStats): EditPattern | null {
  if (stats.edits === 0) return null;
  const files = Array.from(stats.readHistory).slice(-5);
  const lastVerification = stats.verificationResults[stats.verificationResults.length - 1];

  return {
    description: stats.taskGoal || "unknown task",
    files,
    explorationContext: `${stats.productiveReads} files read, ${stats.reReads} re-reads`,
    verificationCommand: lastVerification?.command ?? "",
    verificationPassed: lastVerification?.passed ?? false,
    timestamp: Date.now(),
    sessionId: stats.sessionCount,
    complexity: stats.taskComplexity,
    frequency: 1,
    successRate: lastVerification?.passed ? 1.0 : 0.0,
  };
}

function learnFromPattern(pattern: EditPattern, memory: SessionMemory) {
  // Add to pattern history
  memory.patterns.push(pattern);
  if (memory.patterns.length > CONFIG.maxMemoryPatterns) {
    memory.patterns = memory.patterns.slice(-CONFIG.maxMemoryPatterns);
  }

  // If pattern succeeded, try to extract a skill
  if (pattern.verificationPassed && pattern.verificationCommand) {
    const existing = memory.skills.find((s) =>
      s.verificationHint === pattern.verificationCommand ||
      similarity(s.description, pattern.description) > 0.6
    );

    if (existing) {
      existing.successCount += 1;
      existing.lastUsedAt = Date.now();
      // Update frequency
      if (existing.steps.length === 0) {
        existing.steps = [`Read ${pattern.files.slice(0, 3).join(", ")}`, `Edit ${pattern.files[0] ?? "target file"}`, `Run ${pattern.verificationCommand}`];
      }
    } else {
      // Only create skill if pattern has enough info
      if (pattern.files.length > 0 && pattern.verificationCommand) {
        memory.skills.push({
          name: generateSkillName(pattern.description),
          description: pattern.description,
          trigger: extractKeywords(pattern.description),
          steps: [
            `Read ${pattern.files.slice(0, 3).join(", ")} to understand the codebase`,
            `Edit ${pattern.files[0] ?? "the target file"} with the fix`,
            `Run ${pattern.verificationCommand} to verify`,
          ],
          files: pattern.files.slice(0, 5),
          verificationHint: pattern.verificationCommand,
          successCount: 1,
          failCount: 0,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          complexity: pattern.complexity,
        });
      }

      // Prune skills
      if (memory.skills.length > CONFIG.maxMemorySkills) {
        // Remove least-used skills
        memory.skills.sort((a, b) => (a.successCount + a.failCount) - (b.successCount + b.failCount));
        memory.skills = memory.skills.slice(-CONFIG.maxMemorySkills);
      }
    }
  }
}

function generateSkillName(description: string): string {
  // Extract first meaningful phrase as skill name
  const cleaned = description
    .replace(/^(fix|add|update|remove|refactor|implement|change)\s+/i, "")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s]/g, "")
    .trim();
  if (cleaned.length > 40) return cleaned.slice(0, 40) + "...";
  return cleaned || "unnamed-skill";
}

function extractKeywords(text: string): string {
  // Extract keywords that can trigger skill matching
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 10);
  return words.join(" ");
}

function similarity(a: string, b: string): number {
  // Simple word-overlap similarity (0.0 - 1.0)
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

function matchSkills(taskDescription: string, skills: LearnedSkill[]): LearnedSkill[] {
  if (!taskDescription || skills.length === 0) return [];

  const lower = taskDescription.toLowerCase();
  const matches: Array<{ skill: LearnedSkill; score: number }> = [];

  for (const skill of skills) {
    let score = 0;

    // Match by trigger keywords
    const triggerWords = skill.trigger.split(/\s+/);
    for (const word of triggerWords) {
      if (lower.includes(word.toLowerCase())) score += 1;
    }

    // Match by description
    if (skill.description) {
      score += similarity(lower, skill.description) * 3;
    }

    // Match by files
    for (const file of skill.files) {
      const base = file.split(/[/\\]/).pop()?.toLowerCase() ?? "";
      if (lower.includes(base)) score += 2;
    }

    // Boost high-success skills
    const total = skill.successCount + skill.failCount;
    if (total > 0) {
      const rate = skill.successCount / total;
      score *= (0.5 + rate * 0.5);
    }

    if (score > 0.5) {
      matches.push({ skill, score });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((m) => m.skill);
}

// ── File Knowledge Graph ───────────────────────────────────────────

function inferFileRole(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".test.ts") || lower.endsWith(".spec.ts") || lower.endsWith("_test.go") ||
      lower.includes("/test/") || lower.includes("__tests__")) return "test";
  if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml") ||
      lower.endsWith(".toml") || lower.endsWith(".ini") || lower.endsWith(".cfg") ||
      lower.includes("config") || lower.includes("setting")) return "config";
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".rst") ||
      lower.includes("doc") || lower.includes("readme")) return "doc";
  if (lower.endsWith(".ts") || lower.endsWith(".js") || lower.endsWith(".py") ||
      lower.endsWith(".go") || lower.endsWith(".rs") || lower.endsWith(".java") ||
      lower.endsWith(".c") || lower.endsWith(".cpp") || lower.endsWith(".h") ||
      lower.endsWith(".css") || lower.endsWith(".html") || lower.endsWith(".vue") ||
      lower.endsWith(".svelte") || lower.endsWith(".jsx") || lower.endsWith(".tsx") ||
      lower.endsWith(".sql")) return "source";
  if (lower.endsWith(".csv") || lower.endsWith(".data") || lower.endsWith(".db") ||
      lower.endsWith(".sqlite")) return "data";
  return "unknown";
}

function updateFileKnowledge(path: string, stats: ToolStats) {
  const normalized = resolve(process.cwd(), path).toLowerCase();
  const existing = stats.fileKnowledge.get(normalized);

  if (existing) {
    existing.lastSeen = stats.sessionCount;
    existing.accessCount += 1;
  } else {
    const baseName = path.split(/[/\\]/).pop() ?? path;
    stats.fileKnowledge.set(normalized, {
      path: normalized,
      role: inferFileRole(path),
      firstSeen: stats.sessionCount,
      lastSeen: stats.sessionCount,
      accessCount: 1,
      description: baseName,
    });
  }
}

function getFileKnowledgePrompt(stats: ToolStats): string {
  if (stats.fileKnowledge.size === 0) return "";

  const entries = Array.from(stats.fileKnowledge.values())
    .sort((a, b) => b.accessCount - a.accessCount)
    .slice(0, 10)
    .map((fk) => {
      const shortPath = fk.path.split(/[/\\]/).slice(-3).join("/");
      return `  ${shortPath} (${fk.role}, seen ${fk.accessCount}x)`;
    });

  if (entries.length === 0) return "";
  return `\n### Known files from previous sessions\n${entries.join("\n")}`;
}

// ── v5: Project Archetype Detection ────────────────────────────────

const ARCHETYPE_DETECTORS: Array<{ type: ProjectArchetype; check: () => boolean }> = [];

function registerArchetypeDetectors() {
  if (ARCHETYPE_DETECTORS.length > 0) return;
  const cwd = process.cwd();
  const exists = (p: string) => existsSync(resolve(cwd, p));
  const readFile = (p: string) => {
    try { return readFileSync(resolve(cwd, p), "utf8"); } catch { return ""; }
  };

  ARCHETYPE_DETECTORS.push({
    type: "minecraft-plugin",
    check: () => {
      if (!exists("pom.xml")) return false;
      const pom = readFile("pom.xml");
      return pom.includes("<groupId>org.spigotmc</groupId>") ||
             pom.includes("<groupId>com.destroystokyo.paper</groupId>") ||
             pom.includes("paper-api") ||
             pom.includes("spigot-api");
    },
  });

  ARCHETYPE_DETECTORS.push({
    type: "web-app",
    check: () => {
      if (!exists("package.json")) return false;
      const pkg = readFile("package.json");
      return /"(next|react|vue|angular|svelte|nuxt|remix|gatsby)"/i.test(pkg);
    },
  });

  ARCHETYPE_DETECTORS.push({
    type: "python-project",
    check: () => {
      return exists("requirements.txt") ||
             exists("setup.py") ||
             exists("pyproject.toml") ||
             exists("Pipfile");
    },
  });

  ARCHETYPE_DETECTORS.push({
    type: "data-science",
    check: () => {
      if (!exists("requirements.txt") && !exists("setup.py")) return false;
      const deps = readFile("requirements.txt") + readFile("setup.py");
      return /pandas|numpy|jupyter|scikit-learn|tensorflow|torch|matplotlib/i.test(deps);
    },
  });

  ARCHETYPE_DETECTORS.push({
    type: "node-library",
    check: () => {
      if (!exists("package.json")) return false;
      const pkg = readFile("package.json");
      return !/"(next|react|vue|angular|svelte)"/i.test(pkg);
    },
  });
}

function detectProjectArchetype(): ProjectArchetype {
  registerArchetypeDetectors();
  for (const detector of ARCHETYPE_DETECTORS) {
    if (detector.check()) return detector.type;
  }
  return "unknown";
}

// ── v5: Repository Context Detection (DEP) ─────────────────────────

interface RepoContext {
  hasGit: boolean;
  recentCommits: string[];
  hasChanges: boolean;
  handoffPaths: string[];
  latestHandoff: string | null;
}

function detectRepositoryContext(): RepoContext {
  const cwd = process.cwd();
  const ctx: RepoContext = {
    hasGit: false,
    recentCommits: [],
    hasChanges: false,
    handoffPaths: [],
    latestHandoff: null,
  };

  // Check git
  if (existsSync(resolve(cwd, ".git"))) {
    ctx.hasGit = true;
    try {
      const log = readFileSync(resolve(cwd, ".git", "HEAD"), "utf8").trim();
      if (log.startsWith("ref: ")) {
        const refPath = log.slice(5);
        const refFile = resolve(cwd, ".git", refPath);
        if (existsSync(refFile)) {
          ctx.recentCommits.push(`HEAD: ${readFileSync(refFile, "utf8").trim().slice(0, 12)}`);
        }
      }
    } catch { /* ignore */ }
  }

  // Find handoff files
  const handoffDirs = [
    "docs/handoffs",
    "docs",
    ".",
  ];

  for (const dir of handoffDirs) {
    const fullPath = resolve(cwd, dir);
    if (!existsSync(fullPath)) continue;
    try {
      const entries = readFileSync(fullPath, "utf8") ? [] : [];
      // Use fs.readdirSync via bash equivalent
      const items = ["LATEST.md", "CURRENT.md", "CHANGELOG.md", "handoff.md"];
      for (const item of items) {
        const itemPath = resolve(fullPath, item);
        if (existsSync(itemPath)) {
          ctx.handoffPaths.push(resolve(dir, item));
        }
      }
    } catch { /* ignore */ }
  }

  // Find the latest handoff
  if (ctx.handoffPaths.length > 0) {
    // Prefer LATEST.md > CURRENT.md > CHANGELOG.md > handoff.md
    const priority = ["LATEST.md", "CURRENT.md", "CHANGELOG.md", "handoff.md"];
    for (const name of priority) {
      const found = ctx.handoffPaths.find((p) => p.endsWith(name));
      if (found) {
        ctx.latestHandoff = found;
        break;
      }
    }
    if (!ctx.latestHandoff) ctx.latestHandoff = ctx.handoffPaths[0];
  }

  return ctx;
}

// ── v5: Archetype-specific exploration strategy ────────────────────

function getArchetypePrompt(archetype: ProjectArchetype): string {
  switch (archetype) {
    case "minecraft-plugin":
      return `
### Project: Minecraft Plugin
This appears to be a Paper/Spigot plugin project.
- **Start with**: plugin.yml, then main class, then event listeners
- **Key files**: pom.xml, plugin/src/main/java/
- **Verify**: mvn verify, mvn package
- **Documentation**: Check docs/ or handoffs/ for project-specific context`;

    case "web-app":
      return `
### Project: Web Application
This appears to be a web application.
- **Start with**: package.json, then src/App.*, then components/
- **Key files**: package.json, tsconfig.json, next.config.js / vite.config.ts
- **Verify**: npm test, npm run build
- **Documentation**: README.md, docs/ for project context`;

    case "node-library":
      return `
### Project: Node.js Library
This appears to be a Node.js library or tool.
- **Start with**: package.json, then src/index.ts
- **Key files**: package.json, tsconfig.json, src/
- **Verify**: npm run typecheck, npm test
- **Documentation**: README.md for API docs`;

    case "python-project":
      return `
### Project: Python Project
This appears to be a Python project.
- **Start with**: requirements.txt / setup.py, then main module
- **Key files**: requirements.txt, setup.py, pyproject.toml
- **Verify**: pytest, python -m pytest
- **Documentation**: README.md for project context`;

    case "data-science":
      return `
### Project: Data Science
This appears to be a data science project.
- **Start with**: requirements.txt, then notebooks/ or src/
- **Key files**: requirements.txt, notebooks/*.ipynb
- **Verify**: pytest, python -m pytest tests/`;

    default:
      return "";
  }
}

function getExplorationStrategy(archetype: ProjectArchetype, repo: RepoContext): string {
  const parts: string[] = [];

  if (repo.hasGit) {
    parts.push("### Git-aware exploration");
    parts.push("- Start by checking **git log** for recent activity: `git log --oneline -10`");
    parts.push("- Check **git status** for uncommitted changes: `git status`");
    if (repo.handoffPaths.length > 0) {
      parts.push(`- **Handoff docs found**: ${repo.handoffPaths.join(", ")}`);
      if (repo.latestHandoff) {
        parts.push(`- Read **${repo.latestHandoff}** first for project context`);
      }
    }
  }

  const archetypeStrategy = getArchetypePrompt(archetype);
  if (archetypeStrategy) parts.push(archetypeStrategy);

  if (parts.length > 0) {
    parts.push("");
    parts.push("**Tip**: For fast-moving projects, static docs may be outdated. Check git history and handoff docs first.");
  }

  return parts.join("\n");
}

// ── v5: Verification Failure Classification ────────────────────────

function classifyVerificationFailure(output: string): FailureCategory {
  const lower = output.toLowerCase();

  if (/syntaxerror|unexpected token|unexpected identifier|parsing error/i.test(lower)) return "syntax";
  if (/typeerror|cannot find name|cannot find module|is not assignable|type '.*' is not assignable/i.test(lower)) return "type";
  if (/test failed|tests failed|failures?:\s*\d+[,\s]|failed:?\s*\d+|not ok|✗|×/i.test(lower) && !/0\s+fail/i.test(lower)) return "test";
  if (/lint|eslint|no-unused|no-undef|prettier|formatting/i.test(lower)) return "lint";
  if (/runtimeerror|uncaught|unhandled|timeout|cannot read property|cannot read properties/i.test(lower)) return "runtime";

  return "unknown";
}

// ── v5: Tool Effectiveness Tracking ───────────────────────────────

function classifyToolTaskType(toolName: string, input: Record<string, unknown>): ToolTaskType {
  if (toolName === "read") {
    const path = String(input.path ?? "");
    if (/\.(json|yaml|yml|toml|ini|cfg|env)/i.test(path)) return "read-config";
    return "explore";
  }
  if (toolName === "bash") {
    const command = String(input.command ?? "");
    if (/npm\s+(test|run\s+test)/i.test(command)) return "verify-test";
    if (/tsc|typecheck/i.test(command)) return "verify-type";
    if (/eslint|lint|prettier/i.test(command)) return "verify-lint";
    if (/(?:^|\s)(pytest|python\s+-m\s+pytest|mvn\s+test|go\s+test|cargo\s+test)/i.test(command)) return "verify-test";
    if (/(?:^|\s)(ls|find|grep|rg|tree|dir)/i.test(command)) return "explore";
    return "unknown";
  }
  if (toolName === "edit" || toolName === "write") return "edit";
  return "unknown";
}

function recordToolEffectiveness(
  toolName: string,
  input: Record<string, unknown>,
  success: boolean,
  stats: ToolStats,
) {
  const taskType = classifyToolTaskType(toolName, input);
  const key = `${toolName}:${taskType}`;

  const existing = stats.toolEffectiveness.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    if (success) existing.successCount += 1;
    else existing.failCount += 1;
  } else {
    stats.toolEffectiveness.set(key, {
      toolName,
      taskType,
      successCount: success ? 1 : 0,
      failCount: success ? 0 : 1,
      lastUsed: Date.now(),
    });
  }
}

function getToolOptimizationPrompt(memory: SessionMemory): string {
  const entries = memory.toolEffectiveness ?? [];
  if (entries.length < CONFIG.toolEffectivenessMinSamples) return "";

  // Group by task type
  const byType = new Map<string, ToolEffectivenessEntry[]>();
  for (const e of entries) {
    const list = byType.get(e.taskType) ?? [];
    list.push(e);
    byType.set(e.taskType, list);
  }

  const hints: string[] = [];
  for (const [taskType, tools] of byType) {
    if (tools.length < 2) continue;
    const total = tools.reduce((s, t) => s + t.successCount + t.failCount, 0);
    if (total < CONFIG.toolEffectivenessMinSamples) continue;

    // Find best tool
    const best = tools.reduce((a, b) => {
      const rateA = a.successCount / Math.max(1, a.successCount + a.failCount);
      const rateB = b.successCount / Math.max(1, b.successCount + b.failCount);
      return rateA > rateB ? a : b;
    });
    const rate = Math.round((best.successCount / Math.max(1, best.successCount + best.failCount)) * 100);
    hints.push(`  For "${taskType}", prefer **${best.toolName}** (${rate}% success, ${best.successCount + best.failCount} uses)`);
  }

  if (hints.length === 0) return "";
  return `\n### Tool effectiveness hints\n${hints.join("\n")}`;
}

// ── v5: Failure Avoidance Prompt ───────────────────────────────────

function getFailureAvoidancePrompt(memory: SessionMemory): string {
  const failures = memory.failurePatterns ?? [];
  if (failures.length === 0) return "";

  // Get recent failures (last 10)
  const recent = failures.slice(-10);

  // Group by category
  const byCategory = new Map<FailureCategory, { count: number; reasons: Set<string> }>();
  for (const f of recent) {
    const entry = byCategory.get(f.failureCategory) ?? { count: 0, reasons: new Set() };
    entry.count += 1;
    if (f.failureReason) entry.reasons.add(f.failureReason);
    byCategory.set(f.failureCategory, entry);
  }

  const hints: string[] = [];
  for (const [category, info] of byCategory) {
    const reasons = Array.from(info.reasons).slice(0, 3).join("; ");
    hints.push(`  ${category}: ${info.count}x recent failures. ${reasons ? `Causes: ${reasons}` : ""}`);
  }

  if (hints.length === 0) return "";
  return `\n### Recent failure patterns (learn from past mistakes)\n${hints.join("\n")}` +
    `\n  Double-check before running similar commands.`;
}

// ── Session Summary ────────────────────────────────────────────────

function generateSessionSummary(stats: ToolStats): SessionSummary {
  const files = Array.from(stats.readHistory)
    .map((p) => p.split(/[/\\]/).slice(-2).join("/"))
    .slice(0, 10);

  // Generate key insight from what happened
  let keyInsight = "";
  if (stats.successfulVerifications > 0) {
    keyInsight = `Successful pattern: ${stats.edits} edits, ${stats.successfulVerifications}/${stats.verifications} verifications passed.`;
  } else if (stats.errors > 0) {
    keyInsight = `Error-prone: ${stats.errors} errors (${stats.consecutiveErrors} consecutive max).`;
  } else if (stats.edits > 0 && stats.verifications === 0) {
    keyInsight = `Edited without verification.`;
  } else {
    keyInsight = `Explored ${stats.productiveReads} files, ${stats.reReads} re-reads.`;
  }

  return {
    sessionId: stats.sessionCount,
    goal: stats.taskGoal,
    complexity: stats.taskComplexity,
    phase: stats.phase,
    edits: stats.edits,
    verifications: stats.verifications,
    passed: stats.successfulVerifications > 0,
    elapsedSeconds: (Date.now() - stats.startedAt) / 1000,
    filesTouched: files,
    keyInsight,
    errors: stats.errors,
    timestamp: Date.now(),
  };
}

// ── Auto-tuning (from v3, enhanced with memory) ────────────────────

function loadSessionCount(): number {
  try {
    const telePath = telemetryFilePath();
    const text = readFileSync(telePath, "utf8");
    return text.trim().split("\n").filter((l) => l.includes('"agent_settled"')).length;
  } catch {
    return 0;
  }
}

function getAdaptiveExploreLimit(memory: SessionMemory): number {
  const base = CONFIG.maxExploreStreak;

  // Phase-aware
  if (stats.phase === "verify" || stats.phase === "done") return Math.min(base, 3);
  if (stats.phase === "edit") return Math.min(base + 2, CONFIG.maxExploreStreakHard);

  // Memory-aware: if past sessions had high re-read rates, tighten exploration
  const recentSummaries = memory.sessionSummaries.slice(-5);
  const avgReReads = recentSummaries.length > 0
    ? recentSummaries.reduce((s, x) => s + (x.keyInsight.includes("re-read") ? 1 : 0), 0) / recentSummaries.length
    : 0;

  let bonus = Math.min(stats.productiveReads, 6);
  if (avgReReads > 0.3) bonus = Math.max(0, bonus - 2);

  return Math.min(base + bonus, CONFIG.maxExploreStreakHard);
}

function getExplorationCharBudget(): number {
  if (stats.phase === "verify") return Math.floor(CONFIG.maxExplorationChars * 0.2);
  if (stats.phase === "edit") return Math.floor(CONFIG.maxExplorationChars * 0.5);
  return CONFIG.maxExplorationChars;
}

// ── Task complexity estimation ─────────────────────────────────────

function estimateTaskComplexity(input: Record<string, unknown>): TaskComplexity {
  const messages = input.messages ?? [];
  const firstMsg = Array.isArray(messages) ? messages[0] : null;
  const text = typeof firstMsg?.content === "string" ? firstMsg.content
    : typeof firstMsg?.content?.[0]?.text === "string" ? firstMsg.content[0].text
    : "";

  const complexityIndicators = {
    complex: [
      "refactor", "redesign", "migrate", "architecture", "large", "multi-file",
      "重构", "重写", "大规模", "架构", "多个文件",
    ],
    simple: [
      "fix", "typo", "rename", "quick", "simple", "small", "one-line", "minor",
      "修复", "拼写", "重命名", "简单", "小改动",
    ],
  };

  let score = 0;
  const lower = text.toLowerCase();
  for (const w of complexityIndicators.complex) if (lower.includes(w)) score += 2;
  for (const w of complexityIndicators.simple) if (lower.includes(w)) score -= 1;
  if (text.length > 500) score += 1;

  if (score >= 2) return "complex";
  if (score <= -1) return "simple";
  return "moderate";
}

// ── Stable hash ────────────────────────────────────────────────────

function stable(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString() + "n";
  if (typeof value === "symbol") return value.toString();
  if (value instanceof Date) return `Date(${value.toISOString()})`;
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Buffer || value instanceof Uint8Array) return `Buffer(${value.length})`;
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(",")}}`;
  }
  return String(value);
}

// ── Telemetry ──────────────────────────────────────────────────────

function logEvent(kind: string, data: Record<string, unknown>) {
  try {
    const path = telemetryFilePath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + "\n",
      "utf8",
    );
  } catch {
    // Telemetry must never break the agent.
  }
}

// ── Path protection ────────────────────────────────────────────────

function isGlobPattern(p: string): boolean {
  return p.includes("*") || p.includes("?");
}

function pathMatchesGlob(pattern: string, path: string): boolean {
  if (!isGlobPattern(pattern)) return false;
  const regexStr = pattern.replaceAll(".", "\\.").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(regexStr, "i").test(path);
}

function pathLooksProtected(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return CONFIG.protectedPathFragments.some((p) => {
    if (isGlobPattern(p)) return pathMatchesGlob(p, normalized);
    return normalized.includes(p.toLowerCase());
  });
}

// ── Shell safety ───────────────────────────────────────────────────

function isDangerousShell(command: string): boolean {
  return [
    /\brm\s+(-rf?|--recursive)\b/i,
    /\bsudo\b/i, /\bmkfs\b/i, /\bdd\s+if=/i,
    /\b(shutdown|reboot|poweroff)\b/i,
    /\bchmod\b[^\n]*\b777\b/i,
    /\bchown\b[^\n]*\s\/(?:\s|$)/i,
    /git\s+reset\s+--hard/i,
    /git\s+clean\s+-[a-z]*f/i,
    /git\s+push\s+[^\n]*--force/i,
    /\b(rmdir|del|rd)\s+\/s\b/i,
    /\bformat\b/i, /\bdiskpart\b/i,
  ].some((pattern) => pattern.test(command));
}

// ── Tool classification ────────────────────────────────────────────

function isExplorationCall(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "read") return true;
  if (toolName !== "bash") return false;
  const command = String(input.command ?? "").trim();
  return /^(rg|grep|find|fd|ls|tree|git\s+(status|log|diff|show)|sed\s+-n|head\b|tail\b|cat\b|type\b|dir\b)/i.test(command);
}

function isVerificationCall(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== "bash") return false;
  const command = String(input.command ?? "");
  if (/(?:^|\s)(npm|pnpm|yarn|bun)\s+(test|run\s+(test|lint|typecheck|check|build))\b/i.test(command)) return true;
  if (/(?:^|\s)(pytest|python\s+-m\s+pytest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|dotnet\s+test)\b/i.test(command)) return true;
  if (/(?:^|\s)(tsc|eslint|ruff|mypy|pyright|biome|oxlint)\b/i.test(command)) return true;
  if (/\b(make|just|task|rake)\s+(test|check|verify|lint|build)\b/i.test(command)) return true;
  if (/^(?:npm|pnpm|yarn|bun)\s+run\s+\S+$/i.test(command.trim())) return true;
  return false;
}

function didVerificationPass(output: string): boolean {
  const lower = output.toLowerCase();

  // Strong pass signals: zero-failure counts (checked BEFORE fail patterns)
  if (/0 failures?/i.test(lower) || /0 errors?/i.test(lower) ||
      /no failures?/i.test(lower) || /no errors?/i.test(lower) ||
      /0 warnings?/i.test(lower) || /0 failing/i.test(lower)) {
    return true;
  }

  // Strong fail signals: non-zero failure counts
  if (/\d+\s+fail(?:ure|ed)?s?\b/i.test(lower) && !/0\s+fail/i.test(lower)) return false;
  if (/\d+\s+errors?\b/i.test(lower) && !/0\s+error/i.test(lower)) return false;
  if (/traceback/i.test(lower) || /exception/i.test(lower)) return false;
  if (/^error:/im.test(lower) || /^[error]/im.test(lower) || /^error/im.test(lower) || /err!/i.test(lower)) return false;
  if (/exit code [^0]/i.test(lower) || /exited with [^0]/i.test(lower)) return false;
  if (/not ok/i.test(lower) || /✗|×/i.test(lower)) return false;
  if (/tests?\s+fail(?:ed|ure)?s?\b/i.test(lower) && !/0\s+fail/i.test(lower)) return false;

  // Pass signals
  if (/ok$/im.test(lower) || /all tests passed/i.test(lower) ||
      /tests?\s+passed/i.test(lower) || /build succeeded/i.test(lower) ||
      /✓|✔/i.test(lower) || /^ok$/im.test(lower) ||
      /success(?:fully)?\s+(completed|finished|done)/i.test(lower)) {
    return true;
  }

  // No clear signals: assume pass
  return true;
}

function isProductiveRead(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== "read") return false;
  const path = String(input.path ?? "");
  if (!path) return false;
  const normalized = resolve(process.cwd(), path).toLowerCase();
  if (stats.readHistory.has(normalized)) {
    stats.reReads += 1;
    return false;
  }
  stats.readHistory.add(normalized);
  updateFileKnowledge(path, stats);
  return true;
}

// ── Phase detection ────────────────────────────────────────────────

function detectPhase(): AgentPhase {
  if (stats.consecutiveErrors >= CONFIG.maxConsecutiveErrors) return "stuck";
  if (stats.edits > 0 && stats.successfulVerifications > 0) return "done";
  if (stats.edits > 0 && stats.verifications > 0 && !stats.lastVerificationPassed) return "verify";
  if (stats.edits > 0 && stats.verifications === 0) return "edit";
  if (stats.productiveReads > 0 || stats.exploreStreak > 0) return "explore";
  return "init";
}

function getPhaseTransitionAdvice(): string {
  switch (stats.phase) {
    case "explore":
      return `You've explored ${stats.productiveReads} new files and made ${stats.edits} edits so far. If you have a hypothesis, make an edit now.`;
    case "edit":
      return `You've made ${stats.edits} edits but haven't run any verification. Run a test/lint/check command to verify your changes.`;
    case "verify":
      if (stats.lastVerificationPassed === false) {
        return `The last verification failed. Diagnose the failure from the output above, then fix the issue.`;
      }
      return `Verification was run. If it passed, the task may be complete.`;
    case "stuck":
      return `You've had ${stats.consecutiveErrors} consecutive errors. Your current approach is not working. Try a completely different strategy.`;
    default:
      return "";
  }
}

// ── Smarter text trimmer ───────────────────────────────────────────

function trimText(text: string, toolName: string): string {
  const max = CONFIG.maxToolResultChars;
  if (text.length <= max) return text;

  const isErrorOrLog = /error|exception|traceback|fail|warn/i.test(text.slice(0, 200)) || toolName === "bash";
  const isJson = text.trim().startsWith("[") || text.trim().startsWith("{");

  if (isJson && text.length < max * 3) {
    return text.slice(0, max) + `\n\n[HARNESS: ${text.length - max} chars omitted — JSON truncated.]\n\n`;
  }

  if (isErrorOrLog) {
    const tail = Math.min(max, text.length);
    return `[HARNESS: ${text.length - tail} chars of leading output omitted — showing recent end.]\n\n${text.slice(-tail)}`;
  }

  const head = Math.floor(max * 0.5);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[HARNESS: ${text.length - max} chars omitted; narrow the query/read range if you need the missing section.]\n\n${text.slice(-tail)}`;
}

// ── Policy prompt ──────────────────────────────────────────────────

const HARNESS_POLICY = `
## DeepSeek Execution Harness v4

Treat coding as a phased control problem: explore → edit → verify → done.

### Phase awareness
The harness tracks which phase you are in and adjusts limits accordingly.
- **Explore phase**: Read/search to understand the codebase. Be efficient — prefer targeted queries.
- **Edit phase**: You have enough context. Make edits. Limit further exploration.
- **Verify phase**: Run tests/lint/typecheck. Fix failures. Do NOT start new exploration.
- **Stuck phase**: After 3+ consecutive errors, your approach is broken. Try something completely different.

### Error recovery
- 1st error: Normal. Fix and retry.
- 2nd consecutive error: Consider a different approach (different tool, different file, different command).
- 3+ consecutive errors: STOP. Your current strategy is failing. Try a completely different approach.

### Token budget
- Exploration (reading/searching) has a character budget. Once spent, you must transition to editing.
- Re-reading files you already read is wasteful — you should already know their contents.
- Keep each read targeted. Read specific lines/sections, not entire files.

### Memory & Learning
- The harness retains knowledge across sessions. Patterns that worked before are saved as "skills".
- If a skill matches the current task, it will be suggested.
- File knowledge from previous sessions is available — avoid re-exploring known files.

### Work loop
1. Restate the concrete target and define observable success.
2. Inspect the smallest amount of repository state needed to form a hypothesis.
3. After 1-3 focused searches/reads, choose a hypothesis. Do not keep browsing merely to feel certain.
4. Make the smallest coherent edit that tests the hypothesis.
5. Run the cheapest reliable verification first; escalate only if needed.
6. If verification fails, diagnose from the new evidence. Do not blindly repeat the same command or edit.
7. Never claim completion without evidence from tools when the task changed code or configuration.

### Tool discipline
- Prefer targeted reads over whole-file or whole-repo dumps.
- Prefer rg/find + focused read over cat of large files.
- Keep edits local and reversible; avoid opportunistic refactors.
- Before destructive operations, stop and ask for permission.
- Do not read secrets or credentials unless the user explicitly asks and it is necessary.
- A repeated tool call with identical arguments is almost never progress: change the query, scope, or hypothesis instead.
- If you read a file you already read, you should already know its contents. Don't re-read without a specific new question.

### Context discipline
- Keep a compact working set: goal, hypothesis, files touched, test evidence, blockers.
- Tool output is evidence, not conversation history. Summarize the useful fact and move on.
- When context becomes long, preserve decisions, file paths, exact failing checks, and next action; discard verbose logs already explained.

### Definition of done
For implementation tasks, done means: requested behavior is implemented, relevant checks were run and PASSED, failures are either fixed or explicitly reported, and the final response names the evidence used to verify the result.
`;

// ── Main extension ─────────────────────────────────────────────────

export default function deepseekHarness(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    stats = freshStats();
    stats.sessionCount = loadSessionCount() + 1;
    stats.startedAt = Date.now();

    // ── Load cross-session memory ─────────────────────────────────
    const memory = loadMemory();
    stats.sessionMemory = memory;

    // Estimate task complexity
    stats.taskComplexity = estimateTaskComplexity(event.input ?? {});

    // Extract task goal from first message
    const messages = (event.input as Record<string, unknown>)?.messages ?? [];
    const firstMsg = Array.isArray(messages) ? messages[0] : null;
    stats.taskGoal = typeof firstMsg?.content === "string"
      ? firstMsg.content.slice(0, 200)
      : typeof firstMsg?.content?.[0]?.text === "string"
        ? firstMsg.content[0].text.slice(0, 200)
        : "";

    // ── Match skills from memory ─────────────────────────────────
    stats.matchedSkills = matchSkills(stats.taskGoal, memory.skills);

    // ── v5: Project Archetype Detection ──────────────────────────
    stats.projectArchetype = detectProjectArchetype();

    // ── v5: Repository Context (DEP) ─────────────────────────────
    const repoCtx = detectRepositoryContext();

    // ── v5: Restore project context from memory ──────────────────
    const cwd = process.cwd();
    const savedCtx = memory.projectContexts?.[cwd];
    if (savedCtx) {
      stats.projectContext = savedCtx;
      // If archetype was detected before, prefer it
      if (savedCtx.archetype !== "unknown") {
        stats.projectArchetype = savedCtx.archetype;
      }
    }

    // ── Build complexity-adaptive system prompt ───────────────────
    let complexityNote = "";
    if (stats.taskComplexity === "simple") {
      complexityNote = "\n### Task is simple\nThis looks like a small, bounded task. Keep reads minimal, make the fix, verify quickly, and finish.";
    } else if (stats.taskComplexity === "complex") {
      complexityNote = "\n### Task is complex\nThis appears to be a multi-step or architectural task. You have more exploration budget, but still: prefer targeted reads over broad scans. Verify after each logical change.";
    }

    // ── Memory-aware prompt injection ─────────────────────────────
    let memoryNote = "";
    if (stats.sessionCount > 1) {
      // Session count awareness
      memoryNote = `\n### Cross-session awareness (session #${stats.sessionCount})\nThis harness has been used ${stats.sessionCount} times across all sessions.`;

      // File knowledge from past sessions
      memoryNote += getFileKnowledgePrompt(stats);
    }

    // ── Skill suggestions ─────────────────────────────────────────
    let skillNote = "";
    if (stats.matchedSkills.length > 0) {
      const skillLines = stats.matchedSkills.map((s, i) => {
        const rate = s.successCount + s.failCount > 0
          ? Math.round((s.successCount / (s.successCount + s.failCount)) * 100)
          : 100;
        return `  ${i + 1}. "${s.name}" (${rate}% success, ${s.successCount + s.failCount} uses)`;
      });
      skillNote = `\n### Matched skills from past sessions\n${skillLines.join("\n")}\nConsider using these known patterns.`;
    }

    // ── Subagent note ────────────────────────────────────────────
    let subagentNote = "";
    const hasSubagent = existsSync(resolve(process.cwd(), ".pi/extensions/subagent/index.ts"));
    if (hasSubagent) {
      subagentNote = `
### Subagent support (parallel execution, JSON-RPC over stdio)
You can spawn subagents for parallel or sequential task execution using the \`subagent\` tool.

Architecture: Subagent Server (常驻进程) + JSON-RPC over stdio 协议
- 进程池管理，避免冷启动
- 流式输出实时推送
- 完整进程生命周期控制

Available agents: scout (fast codebase recon), planner (implementation plans), worker (general-purpose), reviewer (code review).

Use cases:
- **Parallel**: Decompose a task into independent sub-tasks, run them concurrently.
- **Chain**: Run agents sequentially, passing results with {previous} placeholder.
- **Workflow prompts**: /implement <query>, /implement-and-review <query>.

Example: "Use scout to find all auth code, worker to implement the fix, reviewer to check the result."`;
    }

    // ── Auto-tuning note ──────────────────────────────────────────
    let autoTuneNote = "";
    if (stats.sessionCount > CONFIG.autoLearnThreshold) {
      autoTuneNote = `\n### Auto-tuning (${stats.sessionCount} sessions)\nBased on accumulated telemetry, prefer even smaller, more targeted reads.`;
    }

    // ── v5: Archetype & DEP prompt ───────────────────────────────
    let archetypeNote = "";
    const explorationStrategy = getExplorationStrategy(stats.projectArchetype, repoCtx);
    if (explorationStrategy) {
      archetypeNote = `\n${explorationStrategy}`;
    }

    // ── v5: Cross-session restoration note ───────────────────────
    let restorationNote = "";
    if (stats.projectContext) {
      restorationNote = `\n### Resuming project\n- Archetype: ${stats.projectContext.archetype}` +
        `\n- Last session: #${stats.projectContext.lastSessionId}` +
        (stats.projectContext.lastHandoffPath
          ? `\n- Last handoff: ${stats.projectContext.lastHandoffPath}`
          : "") +
        (stats.projectContext.architectureNotes.length > 0
          ? `\n- Known architecture: ${stats.projectContext.architectureNotes.slice(0, 3).join("; ")}`
          : "");
    }

    // ── v5: Failure avoidance hints ───────────────────────────────
    const failureAvoidanceNote = getFailureAvoidancePrompt(memory);

    // ── v5: Tool optimization hints ───────────────────────────────
    const toolOptimizationNote = getToolOptimizationPrompt(memory);

    return {
      systemPrompt: `${event.systemPrompt}\n\n${HARNESS_POLICY}${complexityNote}${memoryNote}${skillNote}${subagentNote}${autoTuneNote}${archetypeNote}${restorationNote}${failureAvoidanceNote}${toolOptimizationNote}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const input = (event.input ?? {}) as Record<string, unknown>;
    const key = `${event.toolName}:${stable(input)}`;

    // ── Update phase on every call ────────────────────────────────
    const newPhase = detectPhase();
    if (newPhase !== stats.phase) {
      logEvent("phase_transition", { from: stats.phase, to: newPhase, edits: stats.edits, verifications: stats.verifications });
      stats.phase = newPhase;
      stats.phaseStartEditCount = stats.edits;
    }

    // ── Repeat detection ──────────────────────────────────────────
    const repeated = (stats.identicalCalls.get(key) ?? 0) + 1;
    stats.identicalCalls.set(key, repeated);

    if (repeated > CONFIG.maxIdenticalToolCalls) {
      const reason = "Harness blocked an identical repeated tool call. Synthesize what you already learned, then change the query, scope, command, or hypothesis.";
      if (stats.lastBlockReason !== reason) {
        stats.lastBlockReason = reason;
        logEvent("blocked_repeat", { tool: event.toolName, input });
        return { block: true, reason };
      }
      stats.lastBlockReason = "";
    }

    // ── Read protection & bounding ────────────────────────────────
    if (event.toolName === "read") {
      const path = String(input.path ?? "");
      if (path && pathLooksProtected(path)) {
        logEvent("blocked_protected_read", { path });
        return { block: true, reason: `Harness blocked reading protected/sensitive path: ${path}. Ask the user if this access is genuinely required.` };
      }

      if (typeof input.limit === "number" && input.limit > CONFIG.maxReadLines) {
        input.limit = CONFIG.maxReadLines;
        logEvent("bounded_read", { path, limit: CONFIG.maxReadLines });
      }

      // Track productive reads (v4: also updates file knowledge graph)
      isProductiveRead(event.toolName, input);
    }

    // ── Write/Edit protection ─────────────────────────────────────
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = String(input.path ?? "");
      if (path && pathLooksProtected(path)) {
        logEvent("blocked_protected_write", { path });
        return { block: true, reason: `Harness blocked modification of protected path: ${path}. Ask the user before changing it.` };
      }
      stats.edits += 1;
      stats.exploreStreak = 0;
      stats.consecutiveErrors = 0;

      // Track edit pattern
      if (event.toolName === "write") {
        stats.totalWrittenChars += String(input.content ?? "").length;
      }

      // Update file knowledge for write targets
      if (path) updateFileKnowledge(path, stats);
    }

    // ── Phase-aware exploration limits ────────────────────────────
    else if (isExplorationCall(event.toolName, input)) {
      stats.exploreStreak += 1;
      const adaptiveLimit = getAdaptiveExploreLimit(stats.sessionMemory);

      if (stats.phase === "verify" || stats.phase === "done") {
        const reason = `Harness: you are in the "${stats.phase}" phase. You have made ${stats.edits} edits and should be verifying, not exploring. Run a verification command or check if your previous verification passed.`;
        if (stats.lastBlockReason !== reason) {
          stats.lastBlockReason = reason;
          logEvent("blocked_wrong_phase", { phase: stats.phase, tool: event.toolName });
          return { block: true, reason };
        }
        stats.lastBlockReason = "";
      }

      if (stats.exploreStreak > adaptiveLimit) {
        const reason = `Harness detected a long exploration streak (${stats.exploreStreak} > ${adaptiveLimit}). ${getPhaseTransitionAdvice()}`;
        if (stats.lastBlockReason !== reason) {
          stats.lastBlockReason = reason;
          logEvent("blocked_explore_loop", { tool: event.toolName, input, streak: stats.exploreStreak, adaptiveLimit, phase: stats.phase });
          return { block: true, reason };
        }
        stats.lastBlockReason = "";
      }
    } else if (event.toolName !== "edit" && event.toolName !== "write") {
      stats.exploreStreak = 0;
    }

    // ── Verification tracking ─────────────────────────────────────
    if (isVerificationCall(event.toolName, input)) {
      stats.verifications += 1;
    }

    // ── Dangerous shell ──────────────────────────────────────────
    if (event.toolName === "bash") {
      const command = String(input.command ?? "");
      if (isDangerousShell(command)) {
        logEvent("dangerous_shell", { command });
        if (!ctx.hasUI) {
          return { block: true, reason: "Harness blocked a destructive shell command in non-interactive mode." };
        }
        const ok = await ctx.ui.confirm("DeepSeek Harness: destructive command", `Allow this command?\n\n${command}`);
        if (!ok) {
          return { block: true, reason: "Destructive command rejected by user." };
        }
      }
    }

    return undefined;
  });

  pi.on("tool_result", async (event) => {
    // ── Track read char counts for token budget ───────────────────
    if (event.toolName === "read" && !event.isError) {
      for (const part of event.content ?? []) {
        if (part?.type === "text" && typeof part.text === "string") {
          stats.totalReadChars += part.text.length;
          if (isExplorationCall(event.toolName, event.input as Record<string, unknown>)) {
            stats.totalExplorationChars += part.text.length;
          }
        }
      }
    }

    // ── Track verification results ────────────────────────────────
    if (isVerificationCall(event.toolName, event.input as Record<string, unknown>)) {
      const outputText = (event.content ?? [])
        .filter((p: any) => p?.type === "text")
        .map((p: any) => p.text)
        .join("\n");
      stats.lastVerificationOutput = outputText;

      const command = String((event.input as Record<string, unknown>)?.command ?? "");
      const passed = event.isError ? false : didVerificationPass(outputText);

      stats.verificationResults.push({
        command,
        passed,
        outputSummary: outputText.slice(0, 200),
        timestamp: Date.now(),
        editsBefore: stats.edits,

        // v5: Failure classification
        failureCategory: passed ? undefined : classifyVerificationFailure(outputText),
      });

      // v5: Record tool effectiveness
      recordToolEffectiveness(event.toolName, event.input as Record<string, unknown>, passed, stats);

      // v5: Learn from failure
      if (!passed && !event.isError) {
        const category = classifyVerificationFailure(outputText);
        const failurePattern: FailurePattern = {
          description: stats.taskGoal || "unknown task",
          failureCategory: category,
          failureReason: outputText.slice(0, 100),
          files: Array.from(stats.readHistory).slice(-3),
          verificationCommand: command,
          timestamp: Date.now(),
          sessionId: stats.sessionCount,
          frequency: 1,
        };

        // Add to memory
        const memory = stats.sessionMemory;
        memory.failurePatterns.push(failurePattern);
        if (memory.failurePatterns.length > CONFIG.maxFailedPatterns) {
          memory.failurePatterns = memory.failurePatterns.slice(-CONFIG.maxFailedPatterns);
        }
      }

      if (event.isError) {
        stats.lastVerificationPassed = false;
      } else {
        stats.lastVerificationPassed = passed;
        if (passed) {
          stats.successfulVerifications += 1;
        }
      }
      logEvent("verification_result", {
        passed: stats.lastVerificationPassed,
        verifications: stats.verifications,
        successfulVerifications: stats.successfulVerifications,
      });
    }

    // ── v5: Tool effectiveness tracking (all tools) ───────────────
    if (!isVerificationCall(event.toolName, event.input as Record<string, unknown>)) {
      recordToolEffectiveness(
        event.toolName,
        event.input as Record<string, unknown>,
        !event.isError,
        stats,
      );
    }

    // ── Error loop detection (exponential backoff) ────────────────
    if (event.isError) {
      stats.errors += 1;
      stats.consecutiveErrors += 1;
      stats.lastErrorTool = event.toolName;
      logEvent("tool_error", {
        tool: event.toolName,
        input: event.input,
        errors: stats.errors,
        consecutiveErrors: stats.consecutiveErrors,
      });

      if (stats.consecutiveErrors >= 1) {
        const hints: Record<number, string> = {
          1: `\n\n[HARNESS: Tool error (1st). Check the command/path and retry with a fix.]\n\n`,
          2: `\n\n[HARNESS: Second consecutive error. Consider a different approach — different tool, different file, or different command.]\n\n`,
          3: `\n\n[HARNESS: Third consecutive error. Your current approach is failing. Try something completely different. Check: does the file exist? Is the command available?]` +
            `\n[HARNESS: Alternative suggestions: use ls to check paths, try a different tool, or ask the user for guidance.]\n\n`,
        };
        const hint = hints[Math.min(stats.consecutiveErrors, 3)];
        if (hint) {
          const errorMsg = { type: "text" as const, text: hint };
          return { content: [...(event.content ?? []), errorMsg] };
        }
      }
    } else {
      stats.consecutiveErrors = 0;
    }

    // ── Smart output trimming ─────────────────────────────────────
    const changed: number[] = [];
    const content = (event.content ?? []).map((part: any, idx: number) => {
      if (part?.type !== "text" || typeof part.text !== "string") return part;
      const trimmed = trimText(part.text, event.toolName);
      if (trimmed !== part.text) {
        changed.push(idx);
        return { ...part, text: trimmed };
      }
      return part;
    });

    if (changed.length === 0) return undefined;
    logEvent("trimmed_tool_result", { tool: event.toolName, parts: changed.length });
    return { content };
  });

  pi.on("session_before_compact", async (event) => {
    logEvent("compaction", {
      reason: event.reason,
      tokensBefore: event.preparation.tokensBefore,
      willRetry: event.willRetry,
      phase: stats.phase,
      edits: stats.edits,
      verifications: stats.verifications,
      errors: stats.errors,
    });

    return undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const elapsed = ((Date.now() - stats.startedAt) / 1000).toFixed(1);

    // ── Extract edit pattern from this session ────────────────────
    const pattern = extractEditPattern(stats);
    if (pattern) {
      stats.editPatterns.push(pattern);
    }

    // ── Generate session summary ──────────────────────────────────
    const summary = generateSessionSummary(stats);

    // ── Save to persistent memory ─────────────────────────────────
    const memory = stats.sessionMemory;
    memory.sessionSummaries.push(summary);
    if (memory.sessionSummaries.length > 20) {
      memory.sessionSummaries = memory.sessionSummaries.slice(-20);
    }

    // Update file knowledge in memory
    for (const fk of stats.fileKnowledge.values()) {
      const existing = memory.fileKnowledge.findIndex((m) => m.path === fk.path);
      if (existing >= 0) {
        memory.fileKnowledge[existing] = fk;
      } else {
        memory.fileKnowledge.push(fk);
      }
    }
    if (memory.fileKnowledge.length > 100) {
      memory.fileKnowledge = memory.fileKnowledge.slice(-100);
    }

    // ── v5: Save project context ─────────────────────────────────
    const projectRoot = process.cwd();
    memory.projectContexts = memory.projectContexts ?? {};
    memory.projectContexts[projectRoot] = {
      projectRoot,
      archetype: stats.projectArchetype,
      lastHandoffPath: detectRepositoryContext().latestHandoff ?? undefined,
      architectureNotes: Array.from(stats.fileKnowledge.values())
        .filter((fk) => fk.role === "source" || fk.role === "config")
        .slice(0, 5)
        .map((fk) => `${fk.path.split(/[/\\]/).slice(-2).join("/")} (${fk.role})`),
      lastSessionId: stats.sessionCount,
      detectedAt: Date.now(),
    };

    // Prune old project contexts
    const keys = Object.keys(memory.projectContexts);
    if (keys.length > CONFIG.maxProjectContexts) {
      const sorted = keys
        .map((k) => ({ key: k, ctx: memory.projectContexts[k] }))
        .sort((a, b) => b.ctx.detectedAt - a.ctx.detectedAt);
      const newCtxs: Record<string, ProjectContext> = {};
      for (let i = 0; i < CONFIG.maxProjectContexts; i++) {
        if (sorted[i]) newCtxs[sorted[i].key] = sorted[i].ctx;
      }
      memory.projectContexts = newCtxs;
    }

    // ── v5: Save tool effectiveness ───────────────────────────────
    memory.toolEffectiveness = Array.from(stats.toolEffectiveness.values());

    // Learn from patterns
    for (const p of stats.editPatterns) {
      learnFromPattern(p, memory);
    }

    saveMemory(memory);

    // ── Telemetry summary ─────────────────────────────────────────
    const teleSummary = {
      phase: stats.phase,
      edits: stats.edits,
      verifications: stats.verifications,
      successfulVerifications: stats.successfulVerifications,
      errors: stats.errors,
      consecutiveErrors: stats.consecutiveErrors,
      productiveReads: stats.productiveReads,
      reReads: stats.reReads,
      totalReadChars: stats.totalReadChars,
      totalWrittenChars: stats.totalWrittenChars,
      taskComplexity: stats.taskComplexity,
      elapsedSeconds: parseFloat(elapsed),
      sessionCount: stats.sessionCount,
      skillsMatched: stats.matchedSkills.length,
      patternsLearned: stats.editPatterns.length,
      totalSkills: memory.skills.length,
    };
    logEvent("agent_settled", teleSummary);

    if (ctx.hasUI) {
      if (stats.edits > 0 && stats.verifications === 0) {
        ctx.ui.notify(
          `DeepSeek Harness: code/config changed (${stats.edits} edits) but no verification ran.`,
          "warning",
        );
      }

      if (stats.verifications > 0 && stats.lastVerificationPassed === false) {
        ctx.ui.notify(
          `DeepSeek Harness: last verification FAILED. Task may not be complete.`,
          "warning",
        );
      }

      if (stats.consecutiveErrors >= CONFIG.maxConsecutiveErrors) {
        ctx.ui.notify(
          `DeepSeek Harness: ${stats.consecutiveErrors} consecutive errors — agent may be stuck.`,
          "error",
        );
      }

      if (stats.edits > 0 && stats.successfulVerifications > 0) {
        ctx.ui.notify(
          `DeepSeek Harness: ${stats.edits} edits, ${stats.successfulVerifications}/${stats.verifications} verifications passed.`,
          "info",
        );
      }

      if (stats.taskComplexity === "complex" && parseFloat(elapsed) > 120) {
        ctx.ui.notify(
          `DeepSeek Harness: complex task completed in ${elapsed}s (${stats.edits} edits, ${stats.totalReadChars.toLocaleString()} chars read).`,
          "info",
        );
      }

      // v4: Memory and skill notifications
      if (stats.matchedSkills.length > 0) {
        ctx.ui.notify(
          `DeepSeek Harness: matched ${stats.matchedSkills.length} skills from past sessions.`,
          "info",
        );
      }

      if (stats.editPatterns.length > 0 && stats.successfulVerifications > 0) {
        ctx.ui.notify(
          `DeepSeek Harness: learned ${stats.editPatterns.length} pattern(s) for future sessions.`,
          "info",
        );
      }

      // ── v5: TUI Dashboard ───────────────────────────────────────
      const dashboardLines: string[] = [];
      dashboardLines.push(ctx.ui.theme.fg("accent", "╔══ DeepSeek Harness v5 ═══════════════"));
      dashboardLines.push(`  ${ctx.ui.theme.fg("dim", "Session")}     #${stats.sessionCount}  ${ctx.ui.theme.fg("muted", `(${stats.projectArchetype})`)}`);
      dashboardLines.push(`  ${ctx.ui.theme.fg("dim", "Edits")}      ${stats.edits}  ${ctx.ui.theme.fg("muted", `(${stats.successfulVerifications}/${stats.verifications} verifications passed)`)}`);
      dashboardLines.push(`  ${ctx.ui.theme.fg("dim", "Memory")}    ${memory.skills.length} skills  ${memory.patterns.length} patterns  ${memory.fileKnowledge.length} files`);

      const failureCount = memory.failurePatterns?.length ?? 0;
      if (failureCount > 0) {
        dashboardLines.push(`  ${ctx.ui.theme.fg("error", "Failures")}  ${failureCount} patterns learned`);
      }

      if (stats.matchedSkills.length > 0) {
        dashboardLines.push(`  ${ctx.ui.theme.fg("success", "Skills")}   ${stats.matchedSkills.length} matched this session`);
      }

      const toolEff = memory.toolEffectiveness?.length ?? 0;
      if (toolEff > 0) {
        dashboardLines.push(`  ${ctx.ui.theme.fg("dim", "Tool Opt")}  ${toolEff} tools tracked`);
      }

      if (stats.projectContext) {
        dashboardLines.push(`  ${ctx.ui.theme.fg("dim", "Project")}  ${stats.projectContext.archetype}`);
        if (stats.projectContext.architectureNotes.length > 0) {
          dashboardLines.push(`  ${ctx.ui.theme.fg("muted", "  Notes")}  ${stats.projectContext.architectureNotes.slice(0, 2).join(" | ")}`);
        }
      }

      dashboardLines.push(ctx.ui.theme.fg("accent", "╚════════════════════════════════════"));

      ctx.ui.setWidget("deepseek-harness-dashboard", dashboardLines, {
        placement: "belowEditor",
      });

      // Auto-clear dashboard after 60 seconds
      setTimeout(() => {
        try {
          ctx.ui.setWidget("deepseek-harness-dashboard", undefined);
        } catch { /* ignore */ }
      }, 60_000);
    }
  });
}