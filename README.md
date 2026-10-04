# pi-workbench

Pi 的实验性扩展工作区：执行节奏与持久记忆 harness、子代理调度、代理角色和提示模板。推荐英文仓库名 **pi-workbench**，因为这里包含多种 Pi 工作流实验，不能概括为单独的 DeepSeek 插件或 Pi 核心实现。

本项目使用 [官方 Pi](https://github.com/earendil-works/pi)，包含其 subagent 示例的复制与改编，不代表官方维护或背书，也不是官方 Pi 的完整源码仓库。另一个项目 pi-reliability-lab 不属于本项目；没有发现本项目源码对它的明确依赖，本项目不引用它的测试成果。

**当前为公开候选整理版，尚未完成全部代码的授权确认。** 原有部署、运维资料和运行数据保留本地；公开范围由 [文件清单](public/manifest.json)限定。不要直接上传整个工作区，也不要把上游的 MIT 许可证解释为全部本地新增代码的授权。

## 实际内容与实验状态

| 内容 | 代码证据 | 当前状态 |
| --- | --- | --- |
| 执行 harness | `public/extensions/deepseek-harness.ts` | 有阶段检测、重复调用与探索限制、输出裁剪、验证文本解析、记忆和技能学习、项目类型检测及 TUI 展示；属于启发式实验 |
| 子代理工具 | `public/extensions/subagent/index.ts` | 注册 `subagent`，支持单任务、并行、链式执行；加入 stdio JSON-RPC 服务、回退启动与状态展示 |
| 调度服务与客户端 | `public/extensions/subagent/subagent-{server,client}.ts` | 有调度槽位和逐任务进程启动代码；不能据此声称跨任务复用同一个模型进程或上下文 |
| 角色与提示模板 | `public/agents/`、`public/prompts/` | 公开角色副本移除了本机特定模型选项；模型继承行为需要分别验证服务路径和回退路径 |
| 原有演示项目 | 本地 `demo-project/` | 包含故意未完成的校验逻辑、密码字段输出和未声明的 Express 依赖，不纳入公开清单 |

功能描述来自当前源码，不能替代端到端验证。字符预算不等于模型 token 上限；受保护路径匹配不构成安全沙箱。源码的 v4 注释、v5 展示和旧说明存在版本口径差异，不作为正式发行版本。

## 环境与开始使用

本次核对到 Node.js **24.15.0**、npm **11.12.1**、已安装 `@earendil-works/pi-coding-agent` **0.84.2**。该安装包要求 Node.js **>=22.19.0**；直接使用的 Pi AI、agent-core、TUI 包为 **0.84.2**，TypeBox 为 **1.3.7**。这是一组本机核验基线，兼容范围与完整依赖锁定仍未建立，不能把旧文档的“0.84.1+”当成兼容性保证。

本项目没有根 package.json 或 lockfile，不支持在根目录运行 `npm ci`。不需要为了本次整理安装或升级全局依赖。安装、配置、使用、卸载分别见 [安装说明](docs/INSTALLATION.md)与[使用说明](docs/USAGE.md)。

先在项目根目录执行离线清单检查与候选副本导出：

```console
python scripts/prepare-public-release.py --check
python scripts/prepare-public-release.py --output .local-audit/release-candidate
```

导出只复制清单中的文件，不初始化 Git、不访问网络、不提交、不推送、不发布 npm。已有输出目录会被拒绝覆盖。生成候选副本不表示已获得发布许可。

## 导航与贡献

- [目录结构](docs/PROJECT_STRUCTURE.md)：公开副本与本地保留内容。
- [来源与归属](docs/PROVENANCE.md)：上游比对依据、逐项待确认内容。
- [第三方声明](docs/THIRD_PARTY_NOTICES.md)：Pi 版权及其他来源边界。
- [公开前验收](docs/PUBLIC_RELEASE.md)：本次验证、限制与剩余事项。

贡献应围绕一个具体行为，附复现方式和对应检查，说明新增代码及复制内容的来源和授权。请使用合成任务与数据，避免提交会话、遥测、记忆、认证配置或截图。新增公开文件必须同步清单和精确忽略规则；不要加入无关桌面修复脚本。

## 许可证状态

确认的 Pi 原始部分采用 MIT，完整原文保存在 [Pi 许可证](public/licenses/PI-MIT.txt)。对 Pi 的本地修改、新增 harness、客户端和服务端，以及未确认来源的模板，作者、复制范围和授权仍待确认；目前没有为它们添加统一许可证或根 MIT 声明。可在权利人确认后考虑 MIT，但该建议不构成授权。详见来源文档。
