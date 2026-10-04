# 安装与卸载

这是待授权确认的实验扩展，先阅读 [许可证边界](PROVENANCE.md)和[已知限制](PUBLIC_RELEASE.md)。下列部署过程供有权使用代码的维护者在独立测试项目中操作，本次整理没有执行全局安装或修改原部署。

## 已核对的运行基线

| 依赖 | 已核对版本 | 依据 |
| --- | --- | --- |
| Node.js | 24.15.0；Pi 要求 >=22.19.0 | 实际版本命令、已安装 Pi package.json 的 engines |
| npm | 11.12.1 | 实际版本命令 |
| Pi coding-agent / AI / agent-core / TUI | 0.84.2 | 已安装各包的 package.json |
| TypeBox | 1.3.7 | 已安装 Pi 依赖元数据及源码 import |
| 子代理服务运行器 | Node.js 24.15.0 已测试 | 使用 Node 原生类型擦除与内置模块，不依赖 tsx，不通过 npx 下载运行器 |
| Python | 3.10 或更新 | 发布清单脚本只使用标准库 |

没有验证其他 Pi 版本、Linux、macOS 或 Bun。没有建立根 package/lockfile；不要在工作区根运行 `npm install` 或 `npm ci`。已安装 Pi 的扩展加载器负责解析工具入口使用的 Pi 模块和 TypeBox；独立服务及共享进程模块仅使用 Node 内置模块，使用已测试的 Node 基线启动。

## 准备 Pi

若已有 Pi 0.84.2，无需重复安装。需要独立测试安装时，可使用经核对的包名和版本：

```console
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.2
node --version
pi --version
```

安装命令没有在本次整理中重新执行；本机已安装版本和包元数据已核对。npm 安装会联网，传递依赖未由本项目锁定。当前官方 Pi 的版本可能更高；不要在没有回归验证时自动升级本扩展。

## 在独立项目中试用

首次试用 `/scout-and-plan` 可先使用[合成示例与离线准备入口](DEMO.md)。它只复制该场景需要的子代理扩展、两个角色和一个提示，不加载 harness，也不调用模型。下面保留完整扩展工作区的手动安装方式。

在仓库根目录运行以下 PowerShell 命令。`sandbox-project` 应为新建目录，不能指向现有部署：

```powershell
New-Item -ItemType Directory -Path ./sandbox-project -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path ./sandbox-project/.pi -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath ./public/extensions -Destination ./sandbox-project/.pi/extensions -Recurse -ErrorAction Stop
Copy-Item -LiteralPath ./public/agents -Destination ./sandbox-project/.pi/agents -Recurse -ErrorAction Stop
Copy-Item -LiteralPath ./public/prompts -Destination ./sandbox-project/.pi/prompts -Recurse -ErrorAction Stop
Copy-Item -LiteralPath ./public/examples/settings.example.json -Destination ./sandbox-project/.pi/settings.json -ErrorAction Stop
Push-Location ./sandbox-project
pi
Pop-Location
```

Pi 在项目 `.pi/extensions/` 中自动发现顶层扩展与子目录 `index.ts`；空 settings 示例不覆盖模型或认证配置。没有复制本地记忆或全局认证。`APPEND_SYSTEM.md` 是可选的项目偏好，默认安装过程不复制它。

模型和认证遵循所选 Pi/provider 的配置。不得把真实密钥写入本仓库。角色没有模型覆盖时，工具传递父代理选定的提供商与模型；角色工具白名单和取消信号也传入服务。子进程关闭自动扩展加载，因此仅由扩展注册的自定义提供商不能直接在子进程使用。首次真实任务前仍须核对认证、模型可用性、费用和运行目录；本轮没有发送模型请求。

CLI 定位优先核对实际 Pi 包元数据，并使用当前 Node 运行其入口，避免 Windows 命令包装器解析问题。特殊安装布局可通过 `PI_SUBAGENT_PI_PATH` 指定已安装 Pi CLI 的绝对 JavaScript 文件路径；此参数是可执行入口配置，不是提供商地址，不应指向服务脚本或未知代码。无需修改全局配置或原部署来运行[不调用模型的检查](TESTING.md)。

## 停用与卸载

在测试项目中使用 `pi --no-extensions` 可停用自动发现的扩展；显式 `-e` 指定的扩展仍会加载。退出 Pi 后，可将本次复制的 `deepseek-harness.ts` 和 `subagent/` 移到项目之外的备份目录；不要删除其他已有扩展或整个 `.pi`。

如果不再使用模板，仅移除本次复制且确认未自行修改的四个角色及七个提示文件；保留需要的运行记忆。若为本次试用单独全局安装了 Pi，可执行：

```console
npm uninstall -g @earendil-works/pi-coding-agent
```

该命令未实际执行。它卸载整个 Pi CLI，可能影响其他工作区；不是停用单个扩展所必需的步骤。本次整理未改动原 `.pi`，恢复原部署无需回滚配置。
