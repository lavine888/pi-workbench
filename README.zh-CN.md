# pi-workbench

[English](README.md) · [简体中文](README.zh-CN.md)

**从陌生代码库，到有文件依据的实施计划。**

面向 [Pi](https://github.com/earendil-works/pi) 的实验性工作流：侦察源码、规划改动、委派实施、审查结果。先从 **`/scout-and-plan`** 开始，让 scout 收集源码上下文，再交给 planner 制定计划。

> **实验性 / `pending-rights-review`。** 真实模型工作流仍待端到端验证；本地新增和部分上游改编内容仍需确认来源与授权。

[快速上手](#快速上手) · [能力](#能力与上游边界) · [验证状态](#验证状态) · [限制](#配置数据与限制) · [许可证](#来源与许可证)

## 快速上手

推荐示例是合成阅读清单 CLI：让 scout 与 planner 规划 `--tag` 筛选功能，**不实施修改**。这条路线只加载子代理扩展，不加载执行 harness。

**前提：** 已安装 Node.js 和 Pi 0.84.2，并通过 Pi 配置所选提供商与模型。仓库记录的实际 Pi 基线为 Windows / Node.js 24.15.0；其他 Pi 版本和完整 macOS/Linux 工作流尚未验证。仓库根目录没有 `package.json` 或 lockfile，不要在根目录执行 `npm install` 或 `npm ci`。缺少 Pi 时先阅读[安装说明](docs/INSTALLATION.md)。

在仓库根目录运行：

```console
node scripts/create-demo.mjs
node scripts/check-demo.mjs
```

这两条命令按显式清单复制 15 个文件到被忽略的新目录 `.local-audit/scout-plan-demo/`，并检查示例和副本完整性。它们**不请求模型**，示例无需安装 npm 依赖，已有目录不会被覆盖。

确认认证、父代理与子代理所用模型及调用费用后：

```console
cd .local-audit/scout-plan-demo
pi --no-extensions -e ./.pi/extensions/subagent/index.ts
```

在 Pi 中输入以下内容，并审阅项目代理确认提示：

```text
/scout-and-plan Plan a case-insensitive --tag filter for this reading-list CLI; combine it with --status, reject blank or missing tags, and cite source files and lines. Do not modify files. Read TASK.md for requirements.
```

预期得到 scout → planner 的交接，以及包含文件引用、测试和风险的具体计划。**目前尚无该示例的真实模型运行记录。** [人工验收标准](public/examples/scout-plan-project/EXPECTED_PLAN.md)不是模型输出，也不会复制到代理工作目录。

退出 Pi，返回仓库根目录，再运行 `node scripts/check-demo.mjs`，检查复制的源码、角色或提示是否改变。模型覆盖、其他输出目录、验收标准与录制安排见[演示指南](docs/DEMO.md)。

## 能力与上游边界

pi-workbench 运行在已安装的 Pi CLI 中，是实验性扩展与模板集合，不是官方 Pi 项目。

| 组件 | 提供什么 | 来源与范围 |
| --- | --- | --- |
| `subagent` 工具 | 单任务、并行和串联委派；通过 `{previous}` 传递上一步文本结果 | 模式与代理发现来自或改编自 Pi [子代理示例](https://github.com/earendil-works/pi/tree/v0.84.1/packages/coding-agent/examples/extensions/subagent) |
| 进程编排 | stdio JSON-RPC 调度、任务状态、共享进程处理、取消和启动回退 | 本地改造；已有合成进程检查，真实提供商行为仍待验证 |
| 四个角色 | `scout`、`planner`、`worker`、`reviewer` | 提示包含上游内容及本地改编；指令不构成 OS 权限 |
| 七个提示工作流 | 侦察、规划、实施、审查、调试、文档、重构和测试 | 模型驱动指令，不是确定性工作流程序 |
| 可选执行 harness | 阶段引导、重复调用检查、文本裁剪、本地记忆和遥测 | 独立的启发式实验；推荐示例不加载它 |

源码设置最多 **8 个并行任务**、**4 个并发槽位**。每个任务仍启动独立 Pi 进程，槽位不会保留模型上下文。这些是配置值，不是实测吞吐量。

工具先尝试服务路径；只有服务启动失败时可以回退为直接启动进程，已提交任务不会自动重放。详见[使用说明](docs/USAGE.md)与[来源记录](docs/PROVENANCE.md)。

## 使用示例

项目模板加载后，在 Pi 内使用提示命令：

| 提示 | 角色顺序 | 预期结果 |
| --- | --- | --- |
| `/scout-and-plan` | scout → planner | 侦察并规划，不实施 |
| `/implement` | scout → planner → worker | 侦察、规划并实施 |
| `/implement-and-review` | worker → reviewer → worker | 实施、审查并应用反馈 |
| `/debug` | scout → worker | 调查、修复并验证 |
| `/document` | scout → worker | 读取源码并编写文档 |
| `/refactor` | scout → planner → worker | 规划并进行针对性重构 |
| `/test` | worker → worker | 实施改动，再补充并执行测试 |

以下是直接串联的 **`subagent` 工具参数**，不是 shell 命令：

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

一次只选一种模式：`agent` + `task`、`tasks` 或 `chain`。默认代理作用域为 `user`，使用复制的项目角色时选择 `project`。项目代理确认只在可用的交互 UI 中显示。是否以及如何遵循提示工作流由模型决定。更多参数与示例见[使用说明](docs/USAGE.md)。

## 验证状态

| 证据 | 已记录范围 | 不能证明什么 |
| --- | --- | --- |
| 四个示例 CLI 测试 | 夹具现有行为；示例检查还核对副本完整性 | 模型输出质量或规划中的 `--tag` 功能已成功实现 |
| 19 项进程／协议测试 | 真实本地服务与合成子 CLI；记录了 Windows / Node.js 24.15.0，并在 Linux / Node.js 24.19.0 复跑 | 真实 Pi 子任务、提供商侧取消或实际 TUI 行为 |
| 实际 Pi 0.84.2 检查 | 先前 Windows 版本／帮助、扩展加载及使用合成子 CLI 的工具交接 | 真实 scout/planner 输出或模型端到端验证 |
| 真实模型演示与终端 GIF | 待完成 | 不宣称实测工作流成功率、耗时或 token 节省 |
| 执行 harness 效果 | 本仓库尚未建立证据 | 不宣称可靠性提升 |

在仓库根目录运行已有的不调用模型检查：

```console
node --test tests/subagent.test.mjs
python scripts/prepare-public-release.py --check
```

公开清单检查需要 Python **3.10+**，验证清单、指定敏感模式、JSON/Python 语法、相对文档链接与精确忽略规则。它不验证模型行为，也不能证明没有任何秘密。候选副本导出方式见[公开前验收](docs/PUBLIC_RELEASE.md)。

其他项目的测试或 benchmark 不是本仓库成绩。涉及 `guarded-harness.ts` 的报告须先明确其仓库、revision 和扩展哈希，才能与本实现建立对应；本仓库没有该文件及其 benchmark runner。

## 可选执行 Harness

[Harness](public/extensions/deepseek-harness.ts) 自动挂接 Pi 事件，没有 `/harness` 命令。它从工具活动推断阶段，检查重复调用，裁剪较大的文本输出，并在本地 JSON 中保存模式、文件知识与会话摘要。

**验证结果来自文本启发式，可能误判。** 当前解析器会把空输出视为成功，可能在存在失败信号时接受零错误文字，还会因字符类表达式误判行内容。不要将其结果当作任务完成或 CI 通过的证据；阶段标签与学习模式也受这些不确定性影响。

读取、探索和写入字符数不是模型 token 上限。16,000 字符裁剪阈值不是硬执行预算，当前 hooks 未强制执行探索字符预算和总字符预算。独立技能文件读取仍是占位实现。

完整扩展工作区使用[安装说明](docs/INSTALLATION.md)中的另一条路线，会同时加载 harness 和 subagent；上面的推荐规划示例不加载 harness。

## 配置、数据与限制

- **模型配置：** 公开角色没有固定模型覆盖。角色未覆盖时传递父代理选定的 provider/model，并将声明的工具传入 Pi CLI 白名单。子进程关闭自动扩展加载，仅由扩展注册的提供商与工具不会自动继承。真实任务前核对认证与可用性。
- **运行方式：** 宿主 imports 由 Pi 扩展加载器解析；服务使用 Node 原生 TypeScript 支持和内置模块，不通过 `npx` 下载运行器。`PI_SUBAGENT_PI_PATH` 覆盖方式与基线见[安装说明](docs/INSTALLATION.md)。
- **本地数据：** 工作目录有 `.pi` 时，harness 写入 `.pi/deepseek-harness/`；否则使用所选主目录下的 `pi/deepseek-harness/`。遥测与记忆可能含任务上下文、路径、工具输入和验证输出。JSON 写入没有显式锁或原子更新。
- **隐私：** 已提交的配置与记忆示例为空或合成数据。真实会话、遥测、记忆与凭据应排除提交；本仓库忽略规则不会保护另一个安装扩展的项目。
- **权限：** 角色提示、确认和受保护路径匹配不构成 OS 沙箱。正常关闭清理本次临时提示，强行终止可能遗留文件；终止本地进程不证明提供商侧请求已取消。
- **待验证：** 真实模型输出、实际 TUI、提供商侧取消、其他 Pi/Node 版本及完整 macOS/Linux 工作流。

## 文档与贡献

详细指南目前使用中文。

| 文档 | 内容 |
| --- | --- |
| [演示指南](docs/DEMO.md) | 夹具、验收标准与录制步骤 |
| [安装说明](docs/INSTALLATION.md) / [使用说明](docs/USAGE.md) | 完整安装、配置、参数和卸载 |
| [测试说明](docs/TESTING.md) / [公开前验收](docs/PUBLIC_RELEASE.md) | 检查、历史证据与剩余验证 |
| [目录结构](docs/PROJECT_STRUCTURE.md) | 候选布局与原工作区边界 |

贡献聚焦一个具体行为，附复现步骤和相关检查，并说明复制或改编材料的来源。使用合成数据。新增公开文件必须同步 `public/manifest.json` 与精确 `.gitignore` 白名单。独立 `CONTRIBUTING.md` 待贡献与授权政策确定后补充。

## 来源与许可证

已确认的 Pi 上游内容采用 MIT，完整原文保存在 [PI-MIT.txt](public/licenses/PI-MIT.txt)。本地新增和部分改编仍需确认来源与授权；本仓库没有覆盖全部内容的统一 MIT 许可证。

[清单](public/manifest.json)保留 `publication_status: "pending-rights-review"`。来源比较基线是 Pi v0.84.1，实际 Pi 运行基线为 0.84.2。边界见[来源与归属](docs/PROVENANCE.md)和[第三方声明](docs/THIRD_PARTY_NOTICES.md)。
