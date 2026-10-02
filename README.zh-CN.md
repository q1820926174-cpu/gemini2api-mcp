# gemini2api-mcp

[gemini2api](https://github.com/xwteam/gemini2api)（把 **Gemini 网页版封装成 OpenAI 兼容 API**
的自部署服务，基于浏览器 Cookie）的 **MCP 包装层 + 凭据自动巡检 + 服务端加固补丁**。

本仓库包含这类部署中跑在**客户端侧**的全部内容：

| 组件 | 作用 |
|---|---|
| `server.mjs` | MCP 服务器，暴露 `gemini_chat` 工具（文本/图片/PDF/Office 附件），可供 ZCode、Claude Code、Codex、OpenAI Agents 等任意 MCP 客户端调用 |
| `check.mjs` + `run-scheduled.mjs` + `ssh_tunnel.py` | 凭据自动同步：读取本机已登录 Chrome 的 Google Cookie，与管理端 SHA-256 指纹比对，仅在服务空闲时通过真实网页表单提交一次更新 |
| `launchagent/` | macOS LaunchAgent 模板，每 5 分钟跑一次巡检 |
| `service-patch/` | 上游服务的加固与修复补丁（Docker 非 root、管理 API 凭据脱敏、空闲预约式 Cookie 更新、原子持久化 + 回归测试） |
| `calibration/` | 研究：Gemini 返回坐标的规律，以及让它像素级精准的提示词配方（28/28 目标 ≤1px） |

## 依赖的项目

1. **[xwteam/gemini2api](https://github.com/xwteam/gemini2api)**（上游服务，**非商业许可**）
   本仓库包装的服务端。先部署它，才有 `http://主机:5918/openai/v1` 端点、`/admin`
   管理接口和 Cookie 账号池。`service-patch/` 下的文件是该项目的衍生修改，跟随其许可。
2. **[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)**
   （`@modelcontextprotocol/server`，npm）— `server.mjs` 的 MCP 协议实现。
3. **[zod](https://github.com/colinhacks/zod)**（npm）— 工具入参 schema。
4. **[paramiko](https://github.com/paramiko/paramiko)**（Python）— 管理流量的环回 SSH 隧道（`ssh_tunnel.py`）。
5. **一个在 `127.0.0.1:10086` 上说 `{action, args}` JSON 协议的 Chrome 自动化桥**
   （navigate / fill / click / evaluate / cdp `Network.getCookies`）。参考实现是 Kimi
   WebBridge 扩展 + 原生守护进程（`~/.kimi-webbridge/bin/kimi-webbridge`）；任何同协议的
   CDP 桥均可。
6. **Node.js ≥ 20**（内置 `fetch`、`AbortSignal.timeout`）与 **Python ≥ 3.11**。
   调度/通知部分仅 macOS（LaunchAgent + `osascript`）；MCP 包装层本身跨平台。

相关项目：[UI-Venus-MCP](https://github.com/q1820926174-cpu/UI-Venus-MCP) ——
跨平台 Computer-Use MCP，可将本端点接为可插拔视觉 provider（见其
`docs/gemini-coordinate-calibration.md`）。

## 快速开始

```bash
git clone https://github.com/q1820926174-cpu/gemini2api-mcp
cd gemini2api-mcp
npm install
cp .env.example .env   # 填入你的服务地址与密钥
npm start              # stdio MCP 服务器
```

在 MCP 客户端注册（ZCode `~/.zcode/cli/config.json` 示例）：

```json
{
  "mcp": { "servers": {
    "gemini2api": {
      "command": "node",
      "args": ["/绝对路径/gemini2api-mcp/server.mjs"]
    }
  }}
}
```

工具入参（`gemini_chat`）：

```jsonc
{
  "prompt": "这张图里有什么？",
  "model": "gemini-flash",              // 或 gemini-pro / -lite / -thinking
  "system": "可选的系统指令",
  "images": ["/绝对路径/图片.png"],      // 最多 8 个
  "attachments": ["/绝对路径/文档.pdf"],  // 最多 8 个（pdf/文本/office）
  "max_tokens": 4096
}
```

限制：单轮无上下文；单次最多 8 文件 / 20 MiB；上游超时 180 s（带图请求需
5–120 s，MCP 客户端超时低于 ~180 s 会截断带图调用）。

## 凭据自动巡检（可选）

Google 会轮换 gemini2api 背后的 `__Secure-1PSID*` Cookie；轮换后服务开始失败，
通常要人工往管理面板重贴 Cookie。巡检器安全地自动化这件事：

- 只在内存中读取已登录 Chrome 的两个 Cookie。
- 比对 本地 / 服务端已配置 / 服务端已持久化 三方 SHA-256 指纹。
- 仅在**不一致且服务空闲**时，通过真实网页表单提交一次更新，并验证持久化；
  服务忙 → `DEFERRED_BUSY`；上次更新未确认 → 阻止再次写入。
- SSH 隧道仅环回；状态文件只存哈希不存凭据。细节见
  [CREDENTIAL-CHECK.md](CREDENTIAL-CHECK.md)。

```bash
npm test               # 单元测试（无网络）
npm run check          # 手动巡检一次
npm run check -- --read-only
cp launchagent/com.example.gemini2api-credential-check.plist \
   ~/Library/LaunchAgents/   # 先改里面的路径
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.gemini2api-credential-check.plist
```

## 坐标标定（自动化用途）

Gemini 默认**不在图像像素坐标系**里报坐标——同一张图三次运行分别自报
800×600、1000×750、711×711。在提示词里声明精确尺寸后即像素级精准：
4:3 / 2:1 / 16:9 共 **28/28 目标 ≤1px**。提示词配方、换算公式与可复现实验见
[calibration/README.md](calibration/README.md)。

## 安全说明

- 代码与日志中无任何凭据：全部来自 `.env`（已 gitignore）或环境变量，见 `.env.example`。
- SSH 隧道拒绝未知主机（`RejectPolicy` + `known_hosts`）。
- Cookie 更新走面板自己的表单（输入框掩码）；巡检结束后清空已填字段与隧道源的管理令牌。
- `service-patch/` 额外对管理 API 响应中的 `psid` 脱敏、容器非 root 运行。

## 许可

MIT —— 但 `service-patch/` 衍生自
[xwteam/gemini2api](https://github.com/xwteam/gemini2api)，跟随其**非商业许可**
（仅限个人学习/研究/自部署），见 [service-patch/LICENSE-NOTE.md](service-patch/LICENSE-NOTE.md)。
