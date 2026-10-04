# 使用与数据边界

先在[独立测试目录](INSTALLATION.md)加载扩展。harness 自动挂接 Pi 事件，没有独立的 `/harness` 命令。本次仅验证不发送模型请求的检查；以下工具调用是接口示例，真实任务会使用模型并可能读写项目文件。

## 子代理参数

`subagent` 的三个模式只能选择其中一个。默认 `agentScope` 为 `user`；使用本项目角色需要显式设为 `project` 或 `both`。项目角色在交互 UI 中默认请求确认；非 UI 模式不能依靠此确认建立权限边界。

```json
{
  "agent": "scout",
  "task": "Read the synthetic fixture and summarize its structure; do not modify files.",
  "agentScope": "project",
  "confirmProjectAgents": true
}
```

并行模式使用 `tasks` 数组；链式模式使用 `chain`，通过 `{previous}` 注入上一项结果。源码限制最多 8 个并行任务、4 个并发槽位；不是本次测得的吞吐量或成功率。参数可带 `cwd`，应选择准备好的测试项目目录。

提示模板可通过 Pi 的 `/scout-and-plan`、`/implement`、`/implement-and-review` 等入口使用。提示模板中的自然语言不是确定性执行脚本；最终是否调用子代理以及调用参数仍取决于模型。

## Harness 的输出

harness 检测 explore/edit/verify 等阶段，统计字符、编辑、错误和验证结果，可能阻止重复调用、裁剪文本并追加提示。验证成功判断是输出文本启发式，不是独立测试运行器；例如零错误文字可能覆盖其他失败信号，不能作为 CI 通过的证据。

harness 将路径、任务目标、工具输入、部分验证结果和模式写入运行数据。工作目录存在 `.pi` 时，遥测和记忆位于 `.pi/deepseek-harness/`；否则回退到用户主目录下的 `pi/deepseek-harness/`。技能目录使用后者，当前技能主要嵌入 memory JSON，独立技能读取仍是占位实现。`events.jsonl`、`memory/memory.json` 与生成内容均应保留本地，可能含敏感数据。不要复制实际运行数据作公开案例；[合成记忆示例](../public/examples/memory.synthetic.json)仅展示空结构，不是运行成绩。

## 服务分支的已知边界

- 客户端尝试 `npx tsx` 启动服务；本机没有已确认的 tsx 安装，可能联网安装未固定版本。
- 服务端为每个任务启动 Pi 进程，调度槽位不等于长期复用 worker 进程。
- 服务请求没有完整传递角色的 model/tools 配置及取消信号，回退路径行为不同。
- Windows 下 `npx`、Pi 命令包装器和 `shell: false` 的组合仍需真实验证；默认 Node 回退也不保证正确启动 Pi。
- 不提供 OS 沙箱或确定的文件访问控制，不保证避免递归加载、并发写记忆冲突或模型错误。

首次真实使用应在无敏感文件、可恢复的项目中分别验证单任务、并行、链式、错误、取消、超时与退出清理。不要据本次文件整理宣称这些集成路径已经通过。
