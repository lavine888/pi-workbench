# 项目结构

整理日期：2026-10-04。本次枚举了隐藏目录和普通目录，检查全部可读文本、JSON、源码、脚本和压缩包成员；二进制安装包只检查元数据与哈希并排除公开。项目及祖先目录未发现适用的磁盘 AGENTS.md，执行本次用户提供的工作约定。工作区不是 Git 仓库，也不属于父级 Git 仓库；没有初始化 Git。

## 公开候选文件

```text
README.md
.gitignore
docs/
  PROJECT_STRUCTURE.md
  PROVENANCE.md
  INSTALLATION.md
  USAGE.md
  THIRD_PARTY_NOTICES.md
  PUBLIC_RELEASE.md
scripts/
  prepare-public-release.py
public/
  manifest.json
  extensions/
    deepseek-harness.ts
    subagent/
      agents.ts
      index.ts
      subagent-client.ts
      subagent-server.ts
  agents/                       # 四个通用角色的候选副本
  prompts/                      # 七个提示模板的候选副本
  examples/
    settings.example.json
    memory.synthetic.json
    APPEND_SYSTEM.md
  licenses/
    PI-MIT.txt
```

准确范围以 `public/manifest.json` 为准。公开副本保留源码行为；四个角色的副本仅删除 `model:` 行，不复制本机模型配置。七个提示副本增加显式 project 作用域说明，使其能使用项目角色。原 `deepseek-implement.md` 依赖未纳入清单的专用角色并使用未经确认的参数占位方式，因此保留本地。配置和记忆示例是新建的空配置与合成数据。`.gitignore` 逐文件放行，未列出的新文件默认忽略；必要源码位于公开清单，而原始运行目录整体保留本地。

## 本地原文件与用途

| 相对位置 | 内容与处理 |
| --- | --- |
| `.pi/extensions/` | 原有两套扩展及其模块。保留位置与字节内容，避免影响现有 Pi 使用 |
| `.pi/settings.json` | 原配置把两个文件放在 `packages` 中，并使用反斜杠；用途按部署配置保留，本次不擅自改为其他加载方式 |
| `.pi/agents/`、`.pi/prompts/`、`.pi/APPEND_SYSTEM.md` | 原角色与模板保留；公开副本的映射见清单 |
| `.pi/deepseek-harness/*.md` | 原有迭代与架构描述。保留，公开说明由源码证据重写，避免重复过期声明 |
| `.pi/deepseek-harness/events.jsonl`、`.pi/deepseek-harness/memory/` | 遥测、任务上下文和记忆；本地保留且忽略 |
| `AGENT-STATE/` | 个人运维记忆、资源位置和修复技能；本地保留且忽略 |
| `demo-project/` | 独立的未完成练习；保留且忽略，不作为可运行公开示例 |
| 根目录 `.ps1`、`.bat` | 桌面进程、应用注册、修复、恢复、启动和额度查询操作；本地保留且忽略，未执行 |
| 根目录架构报告 | 本地研究说明，尚未确认引用来源和复用权限；保留且忽略 |
| `tmp/`、根目录日志、`nul` | 临时状态和输出；本地保留且忽略 |
| 根目录 ZIP 与 EXE | 归档资料、第三方安装包；保留且忽略，未执行或整体复制 |
| `.local-audit/` | 逐文件清单、哈希、上游基线、风险位置、验证记录及发布候选目录；明确忽略 |

本项目唯一原有 package.json 位于 `demo-project/`，没有声明 Express；没有找到原有 lockfile、根构建配置或核心扩展测试套件。运行时依赖来自已安装 Pi，不能视为本工作区的锁定依赖。

## 维护边界

不移动部署文件，不覆盖既有输出，不修改注册表、进程、全局安装、认证目录或外部项目。pi-reliability-lab 的引用仅出现在本地任务资料中，没有发现核心源码导入、配置包依赖或构建依赖；不合并它的代码、文档或测试成绩。
