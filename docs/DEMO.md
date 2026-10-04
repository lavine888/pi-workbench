# 主打场景：从陌生项目到有依据的计划

使用 `/scout-and-plan`，让 scout 侦察源码、planner 根据交接内容给出实施计划。示例是一个无外部依赖的合成阅读清单 CLI：已有状态筛选，任务是规划标签筛选，明确不实施修改。

**当前状态：离线准备完成；真实模型执行与终端录制暂缓。** 没有 GIF、实测模型输出或端到端成功声明。“三分钟入口”是减少准备步骤的设计目标，不是实测耗时；模型配置、安装和下载时间另计。

## 环境与创建

已核对基线为 Node.js 24.15.0、Pi 0.84.2、Windows PowerShell。Pi 要求 Node.js >=22.19.0。缺少 Pi 时先按[安装说明](INSTALLATION.md)准备；本示例无需 `npm install`，不会自动安装或升级任何工具。

在仓库根目录执行：

```console
node scripts/create-demo.mjs
node scripts/check-demo.mjs
```

创建脚本只按显式清单复制 15 个文件到新的 `.local-audit/scout-plan-demo/`，包含共享进程处理模块，另生成本地忽略规则和副本哈希清单。它不复制整个工作区、harness、记忆、认证配置或其他项目，也不启动 Pi 或请求模型。输出已存在时会拒绝覆盖；旧副本不自动升级，应另选新目录。

需要多个独立副本时：

```console
node scripts/create-demo.mjs --output .local-audit/scout-plan-demo-2
node scripts/check-demo.mjs --project .local-audit/scout-plan-demo-2
```

输出必须是仓库内的新目录。为避免修改公开源码，不能写入 `public`、`docs`、`scripts` 或 `.git`。默认目录被本仓库忽略；自选输出路径也应保持在 `.local-audit/` 下。

若需要固定子代理模型，可在创建时传入经过自己确认的 `provider/model` 标识。`--model` 仅写入生成副本中的 scout、planner frontmatter，不更改公开角色定义或全局 Pi 配置；它不验证提供商、费用或可用性。工具现已传递角色模型覆盖；未覆盖时传递父代理选定的模型。真实运行前仍须核对提供商、认证及最终使用的模型。

## 真实试用入口

以下真实模型操作**未在本轮执行**。请先确认父代理与子代理实际使用的模型、认证和费用；父模型标识已传递，但提供商可用性及远端行为仍须实际验证。服务／回退路径与模型边界见[使用说明](USAGE.md)。

```console
cd .local-audit/scout-plan-demo
pi --no-extensions -e ./.pi/extensions/subagent/index.ts
```

此父进程命令关闭其他自动发现的扩展，只显式加载示例子代理扩展；子进程也关闭自动扩展加载。仅由扩展注册的自定义提供商不能直接在子进程使用，模型和认证仍需检查。它不会加载示例 harness。提示模板和项目角色保留在项目 `.pi` 中。

在 Pi 中输入：

```text
/scout-and-plan Plan a case-insensitive --tag filter for this reading-list CLI; combine it with --status, reject blank or missing tags, and cite source files and lines. Do not modify files. Read TASK.md for requirements.
```

确认项目代理提示后，预期看到 scout、planner 的任务状态及最终计划。这里描述的是预期行为，尚无真实运行记录。

退出 Pi，返回仓库根目录，再运行 `node scripts/check-demo.mjs`。它核对复制的源码、角色和提示与创建时哈希一致；真实计划任务是否无意修改文件可据此检查。运行 `.pi` 下新增的日志不属于副本哈希清单。若检查失败，应检查差异，不能覆盖原副本来掩盖变化。

## 计划验收标准

人工编写的[验收标准](../public/examples/scout-plan-project/EXPECTED_PLAN.md)保留在仓库中，**不复制到代理工作目录**，避免代理直接复述答案。它不是模型输出。

- 找到 `listBooks`、CLI 参数解析和现有测试，并给出正确的相对文件引用。
- 说明标签大小写、空白处理、与 `--status` 的 AND 关系及兼容行为。
- 给出能执行的实施步骤、测试计划和风险。
- 不实施修改；检查脚本确认原副本完整。

四个基线测试只验证示例 CLI 已有功能。未来 `--tag` 命令是实施完成后的验收命令，当前版本故意不支持。

## 与官方示例的边界

| 内容 | 来源与本项目状态 |
| --- | --- |
| 单任务、并行、串联和角色发现 | 来自或改编自官方 Pi subagent 示例，不作为原创能力宣传 |
| 原有角色与部分工作流提示 | 含上游内容；具体比较与本地改动见[来源说明](PROVENANCE.md) |
| JSON-RPC 调度、任务状态展示与新增工作流 | 本仓库包含本地改造；部分归属和授权仍待确认，真实运行待验证 |
| 执行引导与本地记忆 harness | 另一组实验功能，本次主打场景不加载；不承诺性能或 token 节省 |
| 合成阅读清单、创建／离线检查脚本及验收标准 | 本轮新增准备材料，无模型调用或复制的个人数据 |

[官方示例](https://github.com/earendil-works/pi/tree/v0.84.1/packages/coding-agent/examples/extensions/subagent)是归属比较基线；本机运行基线是 Pi 0.84.2。该版本差异不构成其他版本兼容保证。

## 30～45 秒录制安排

真实工作流成功并完成内容审查后再录制。以下是镜头安排，不是录制结果：

| 时间 | 展示内容 |
| --- | --- |
| 0～5 秒 | 阅读清单项目和 `--tag` 规划任务 |
| 5～15 秒 | 输入 `/scout-and-plan`，展示 scout 状态与文件发现 |
| 15～25 秒 | 展示 planner 接收交接并规划 |
| 25～40 秒 | 展示包含真实文件引用、测试步骤和风险的最终计划 |
| 40～45 秒 | 展示副本完整性检查和复现入口 |

若实际执行更长，可剪辑等待段并标注剪辑；不得将成片时长当作模型运行时长。保留完整原始记录于忽略的本地目录；仅公开脱敏后的真实素材。检查用户名、路径、任务内容、认证输出和成本信息，避免录制整个个人桌面。

## 完成条件与待办

先前发现的启动入口、请求 ID、同角色通知分发和槽位复用问题已在公开副本中修复。19 项[不调用模型的进程／协议检查](TESTING.md)通过；实际 Pi 工具入口也完成合成子 CLI 的模型标识传递、串联交接和不重复执行检查。当前仍没有真实模型端到端记录。

- [x] 合成示例、显式复制入口和离线检查。
- [x] 人工计划验收标准与录制安排。
- [x] 以合成子进程核对服务启动、JSON-RPC 响应和模型／工具参数传递。
- [ ] 使用明确授权的模型完成真实 scout → planner 运行。
- [ ] 核对文件引用和未修改源码，审查运行记录。
- [ ] 录制并公开真实终端 GIF，关联运行环境和复现步骤。
- [ ] 跑通后再增加 `/implement-and-review` 演示。

离线检查不能替代这些真实运行条件。当前没有根 Pi Package 配置，仍使用显式复制方式；[Pi Packages](https://pi.dev/docs/latest/packages) 的 Git／npm 分发作为后续兼容验证事项，本轮不发布 npm。
