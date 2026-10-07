# pi-workbench

[English](README.md) · [简体中文](README.zh-CN.md)

**From an unfamiliar codebase to a file-backed implementation plan.**

Experimental workflows for [Pi](https://github.com/earendil-works/pi): scout the code, plan a change, delegate implementation, and review the result. Start with **`/scout-and-plan`**, which hands source context from scout to planner.

> **Experimental / `pending-rights-review`.** Real model-driven workflows remain unvalidated end to end. Local additions and some upstream-derived modifications still need provenance and license confirmation.

[Quick Start](#quick-start) · [Capabilities](#capabilities-and-upstream-boundary) · [Validation](#validation-status) · [Limitations](#configuration-data-and-limitations) · [License](#provenance-and-license)

## Quick Start

The recommended sample is a synthetic reading-list CLI. Ask scout and planner to propose a `--tag` filter **without implementing it**. This route loads only the subagent extension; it does not load the execution harness.

**Prerequisites:** Node.js and Pi 0.84.2 installed, with your provider and model configured through Pi. The recorded actual Pi baseline is Windows / Node.js 24.15.0. Other Pi versions and full macOS/Linux workflows have not been verified. The repository root has no `package.json` or lockfile; do not run `npm install` or `npm ci` there. See [Installation](docs/INSTALLATION.md) if Pi is missing.

From this repository's root:

```console
node scripts/create-demo.mjs
node scripts/check-demo.mjs
```

These commands copy 15 explicitly listed files into a new ignored `.local-audit/scout-plan-demo/` and check the sample and copy integrity. They make **no model calls**, need no npm installation for the sample, and refuse to overwrite an existing directory.

After confirming authentication, the selected parent/child models, and model costs:

```console
cd .local-audit/scout-plan-demo
pi --no-extensions -e ./.pi/extensions/subagent/index.ts
```

Enter this in Pi, then review the project-agent confirmation:

```text
/scout-and-plan Plan a case-insensitive --tag filter for this reading-list CLI; combine it with --status, reject blank or missing tags, and cite source files and lines. Do not modify files. Read TASK.md for requirements.
```

The intended output is a scout → planner handoff and a concrete plan with file references, tests, and risks. **A real model run of this sample has not yet been recorded.** The [human-written acceptance rubric](public/examples/scout-plan-project/EXPECTED_PLAN.md) is not model output and is kept outside the generated agent workspace.

After exiting Pi, return to the repository root and run `node scripts/check-demo.mjs` again to check whether copied source, roles, or prompts changed. See [Demo](docs/DEMO.md) for model overrides, alternate output directories, acceptance criteria, and the recording plan.

## Capabilities and Upstream Boundary

pi-workbench runs inside an installed Pi CLI. It is an experimental extension and template collection, not an official Pi project.

| Component | What it provides | Source and scope |
| --- | --- | --- |
| `subagent` tool | Single, parallel, and chain delegation; `{previous}` passes the preceding text result | These modes and agent discovery come from or adapt Pi's [subagent example](https://github.com/earendil-works/pi/tree/v0.84.1/packages/coding-agent/examples/extensions/subagent) |
| Process orchestration | stdio JSON-RPC scheduling, task status, shared process handling, cancellation, and startup fallback | Local changes; synthetic process checks exist, real provider behavior remains pending |
| Four roles | `scout`, `planner`, `worker`, `reviewer` | Prompts include upstream material and local adaptations; instructions are not OS permissions |
| Seven prompt workflows | Reconnaissance, planning, implementation, review, debugging, documentation, refactoring, and tests | Model-driven instructions, not deterministic workflow programs |
| Optional execution harness | Phase guidance, repetitive-call checks, text trimming, local memory, and telemetry | Separate heuristic experiment; not loaded by the recommended sample |

The source permits at most **8 parallel tasks** with **4 concurrency slots**. Tasks launch individual Pi processes; slots do not preserve a model context across tasks. These limits are configuration values, not measured throughput.

The tool attempts the service path first. Only a service startup failure may use the direct-process fallback; submitted tasks are not automatically replayed. See [Usage](docs/USAGE.md) and [Provenance](docs/PROVENANCE.md) for details.

## Usage Examples

Use prompt commands inside Pi after loading the project templates:

| Prompt | Role sequence | Intended outcome |
| --- | --- | --- |
| `/scout-and-plan` | scout → planner | Inspect and plan without implementation |
| `/implement` | scout → planner → worker | Inspect, plan, and implement |
| `/implement-and-review` | worker → reviewer → worker | Implement, review, and apply feedback |
| `/debug` | scout → worker | Investigate, fix, and verify |
| `/document` | scout → worker | Inspect code and write documentation |
| `/refactor` | scout → planner → worker | Plan and perform a focused refactor |
| `/test` | worker → worker | Implement a change, then add and run tests |

A direct chain uses these **`subagent` tool arguments**, not a shell command:

```json
{
  "chain": [
    { "agent": "scout", "task": "Inspect the synthetic sample and return context for planning." },
    { "agent": "planner", "task": "Propose a plan without editing files using this context: {previous}" }
  ],
  "agentScope": "project",
  "confirmProjectAgents": true
}
```

Choose exactly one mode: `agent` + `task`, `tasks`, or `chain`. The default agent scope is `user`; use `project` for the copied roles. Project-agent confirmation appears only when an interactive UI is available. The model decides whether and how to follow a prompt workflow. More parameters and examples are in [Usage](docs/USAGE.md).

## Validation Status

| Evidence | Recorded scope | What it does not establish |
| --- | --- | --- |
| Four sample CLI tests | Existing fixture behavior; sample checks also verify copy integrity | Model output quality or success of the planned `--tag` feature |
| 19 process/protocol tests | Real local service with a synthetic child CLI; recorded on Windows / Node.js 24.15.0 and rerun on Linux / Node.js 24.19.0 | Actual Pi child workflows, provider cancellation, or live TUI behavior |
| Actual Pi 0.84.2 checks | Earlier Windows version/help, extension loading, and tool handoffs using a synthetic child CLI | Real scout/planner output or end-to-end model validation |
| Real model demo and terminal GIF | Pending | No measured workflow success, runtime, or token savings claimed |
| Execution harness effectiveness | Not established in this repository | No reliability improvement claim |

Run the existing model-free checks from the repository root:

```console
node --test tests/subagent.test.mjs
python scripts/prepare-public-release.py --check
```

The release check requires Python **3.10+** and validates the public manifest, selected sensitive patterns, JSON/Python syntax, relative document links, and exact ignore rules. It does not validate model behavior or prove that no secrets exist. Local candidate export instructions are in [Release Validation](docs/PUBLIC_RELEASE.md).

Tests or benchmark results from another project are not this repository's results. A report about `guarded-harness.ts` must identify its repository, revision, and extension hash before being associated with this implementation; that file and its benchmark runner are not present here.

## Optional Execution Harness

The [harness](public/extensions/deepseek-harness.ts) attaches to Pi events automatically; there is no `/harness` command. It infers phases from tool activity, checks repetitive calls, trims large text results, and persists patterns, file knowledge, and session summaries in local JSON.

**Verification results are text heuristics and can be wrong.** The current parser can treat empty output as success, accept a zero-error phrase despite failure signals, and misclassify lines using a character-class expression. Do not use its verdict as evidence that a task is complete or CI passed. Phase labels and learned patterns inherit that uncertainty.

Read, exploration, and written character counts are not model token limits. The configured 16,000-character trimming threshold is not a hard execution budget; exploration and total-character budgets are not enforced by the current hooks. Independent skill-file loading is a stub.

For the full extension workspace, use the separate installation route in [Installation](docs/INSTALLATION.md). It loads the harness as well as subagent; the recommended planning sample above does not.

## Configuration, Data, and Limitations

- **Model configuration:** public roles have no fixed model override. The tool forwards the parent's selected provider/model unless a role overrides it, and forwards declared tools to the Pi CLI allowlist. Child processes disable automatic extensions; extension-only providers and tools are not automatically inherited. Check authentication and availability before a real task.
- **Runtime:** host imports are resolved by Pi's extension loader. The service uses Node's native TypeScript support and built-in modules, without `npx` downloads. See [Installation](docs/INSTALLATION.md) for the `PI_SUBAGENT_PI_PATH` override and baseline versions.
- **Local data:** with a project `.pi`, the harness writes under `.pi/deepseek-harness/`; otherwise it uses `pi/deepseek-harness/` beneath the selected home directory. Telemetry and memory may contain task context, paths, tool inputs, and verification output. The JSON writer has no explicit lock or atomic update.
- **Privacy:** the checked-in settings and memory examples are empty/synthetic. Keep real sessions, telemetry, memory, and credentials out of commits. This repository's ignore rules do not protect a separate project where extensions are installed.
- **Permissions:** role prompts, confirmations, and protected-path matching are not an OS sandbox. Normal shutdown cleans owned temporary prompts; abrupt termination may leave them. Killing a local process does not establish provider-side cancellation.
- **Remaining checks:** actual model output, live TUI behavior, provider cancellation, other Pi/Node versions, and full macOS/Linux workflows remain pending.

## Documentation and Contributing

Detailed guides are currently in Chinese.

| Document | Contents |
| --- | --- |
| [Demo](docs/DEMO.md) | Fixture, acceptance rubric, and recording steps |
| [Installation](docs/INSTALLATION.md) / [Usage](docs/USAGE.md) | Complete setup, configuration, parameters, and uninstall |
| [Testing](docs/TESTING.md) / [Release Validation](docs/PUBLIC_RELEASE.md) | Checks, historical evidence, and remaining validation |
| [Project Structure](docs/PROJECT_STRUCTURE.md) | Candidate layout and original workspace boundary |

Contributions should address one concrete behavior, include reproduction steps and relevant checks, and document the provenance of copied or adapted material. Use synthetic data. New public files must be added to `public/manifest.json` and the exact `.gitignore` allowlist. A separate `CONTRIBUTING.md` awaits the contribution and licensing policy.

## Provenance and License

Confirmed upstream Pi material is MIT licensed; the full original text is preserved in [PI-MIT.txt](public/licenses/PI-MIT.txt). Local additions and some adaptations still need provenance and authorization confirmation. There is no blanket MIT license for this repository.

The [manifest](public/manifest.json) retains `publication_status: "pending-rights-review"`. Source comparisons use Pi v0.84.1; the observed actual Pi runtime baseline is 0.84.2. See [Provenance](docs/PROVENANCE.md) and [Third-party Notices](docs/THIRD_PARTY_NOTICES.md) for the boundaries.
