# 第三方内容与许可证边界

## Pi

上游：[earendil-works/pi](https://github.com/earendil-works/pi)。本次内容比对固定到 v0.84.1，提交 `53fa77ccd8a279eb87e92294ef3687b03ff80112`，目录为 `packages/coding-agent/examples/extensions/subagent/`。核验本机运行包版本为 0.84.2，不代表全部本地代码源于该版本。

确认的原始文件：`agents.ts` 与 `implement.md`、`implement-and-review.md`、`scout-and-plan.md` 三个提示模板。`index.ts` 有本地改编；`worker.md`、`scout.md`、`planner.md`、`reviewer.md` 相对上游仅修改模型行，公开副本进一步删除模型行。七个公开提示副本增加了 project 作用域指令，该本次整理增量不冒充上游原文。

上游版权为 Copyright (c) 2025 Mario Zechner，采用 MIT。原文完整保存在 [PI-MIT.txt](../public/licenses/PI-MIT.txt)，取自同一上游版本，不改写版权人、年份或条款。该许可证涵盖确认的上游部分；本地改编和新增部分的授权仍须确认。

## 概念参考与其他内容

`deepseek-harness.ts` 文件头声称参考 Hermes Agent 的理念；`subagent-server.ts` 文件头声称参考 OpenAI Codex exec-server 架构。文件头只能证明该声明存在，不能证明没有复制代码、实际复制范围或获得授权。对应新增模块没有找到完整作者或许可证声明，逐项列入 [来源记录](PROVENANCE.md)。本次未导入其他项目实现。

运行时通过安装的 Pi 使用 Pi AI、agent-core、TUI、TypeBox 等依赖。本次没有把 node_modules 或第三方二进制复制进候选目录；依赖包自身的许可由原包管理，不在此重新授权。

本地安装包、ZIP、运维脚本和研究报告均排除公开。它们的存在不等于允许再分发。没有创建覆盖全部工作区的根 LICENSE，也没有给来源未确认的代码添加 SPDX MIT 标记。
