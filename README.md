[中文](#中文) | [English](#english)

# cc2server

## 中文

## A2S 生态（同系列开源仓库）

A2S 按组件拆分为以下同系列仓库，所有者均为 `23J1633`。/ A2S is split into the following sibling repositories, all owned by `23J1633`.

| 仓库 / Repository | 作用 / Role | GitHub |
|---|---|---|
| A2Switch | Windows 桌面控制中心 / Windows desktop control center | [23J1633/A2Switch](https://www.github.com/23J1633/A2Switch) |
| cc2server | Claude Code 桥接器 / Claude Code bridge | [23J1633/cc2server](https://www.github.com/23J1633/cc2server) |
| codex2server | Codex 桥接器 / Codex bridge | [23J1633/codex2server](https://www.github.com/23J1633/codex2server) |
| dsh2server | DeepSeek Harness 插件 / DeepSeek Harness plugin | [23J1633/dsh2server](https://www.github.com/23J1633/dsh2server) |
| server-api | 中转服务与 Web 控制台 / relay server and Web console | [23J1633/server-api](https://www.github.com/23J1633/server-api) |
| a2s_app | Flutter Android 客户端 / Flutter Android client | [23J1633/a2s_app](https://www.github.com/23J1633/a2s_app) |
| scripts | 跨仓库验收脚本 / cross-repository acceptance scripts | [23J1633/scripts](https://www.github.com/23J1633/scripts) |
| ICON | A2S 品牌源图 / A2S brand source artwork | [23J1633/ICON](https://www.github.com/23J1633/ICON) |
| artifacts | 脱敏交付验证产物 / sanitized delivery evidence | [23J1633/artifacts](https://www.github.com/23J1633/artifacts) |

`cc2server` 把本机 Claude Code 接入 A2S 服务器。它把服务器统一方法映射到 Claude Code 的 `stream-json` 输入/输出协议，并把会话、模型回复、运行状态和错误转换为与 `dsh2server` 相同的事件格式。

桥接器只建立本机到服务器的主动出站连接；本机无需开放端口。

## 前置条件

- Node.js 22+；
- Claude Code CLI 已安装并完成登录；
- `claude --version` 能在启动桥接器的用户环境中成功执行；
- 已有 A2S 共享配置，或允许桥接器首次运行时创建一份空端点配置。

## 安装与诊断

```powershell
cd D:\Project\A2S\cc2server
npm install
node .\bin\cc2server.js doctor
```

`doctor` 会检查 Claude 可执行文件并输出配置路径、实例 ID、key 指纹、端点、Claude 版本和默认工作目录，不会输出完整 key。

## 启动

```powershell
node .\bin\cc2server.js start
```

其他命令：

```powershell
node .\bin\cc2server.js config
node .\bin\cc2server.js status
node .\bin\cc2server.js --version
```

指定共享配置和 Claude 专用覆盖文件：

```powershell
node .\bin\cc2server.js start `
  --shared-config D:\config\a2s.json `
  --config D:\config\claude-bridge.json `
  --locale en-US
```

也可以全局链接命令：

```powershell
npm link
cc2server doctor
cc2server start
```

## 配置

默认共享配置路径：

- Windows：`%APPDATA%\A2S\config.json`
- macOS：`~/Library/Application Support/A2S/config.json`
- Linux：`${XDG_CONFIG_HOME:-~/.config}/a2s/config.json`

可通过 `A2S_CONFIG_PATH` 或 `--shared-config` 覆盖。共享配置中的核心字段：

```json
{
  "device": {
    "id": "a2s-0123456789ab",
    "name": "workstation",
    "key": "a2sk_..."
  },
  "server": {
    "endpoints": ["https://example.com/a2s-api"],
    "transport": "auto"
  },
  "agents": {
    "claude": {
      "enabled": true,
      "locale": "system",
      "instanceId": "a2s-0123456789ab:claude",
      "executable": "claude",
      "defaultCwd": "D:\\workspace",
      "autoStart": true
    }
  }
}
```

Claude 专用覆盖文件可参考 [`config.example.json`](config.example.json)：

| 字段 | 默认 | 说明 |
|---|---|---|
| `executable` | `claude`（Windows 通常为 `claude.cmd`） | Claude CLI 路径或命令 |
| `defaultCwd` | 启动目录 | 新会话默认工作目录 |
| `claudeConfigDir` | `~/.claude` | Claude Code 原生配置/历史目录；用于发现 `projects/*/*.jsonl` |
| `model` | `null` | 可选模型别名/ID |
| `reasoningEffort` | `null` | 思考强度：`low` / `medium` / `high` / `xhigh` / `max`；留空采用 Claude 默认 |
| `locale` | `system` | 插件语言：`system` / `zh-CN` / `en-US`；`system` 自动识别运行电脑的语言 |
| `permissionMode` | `default` | Claude 权限模式 |
| `extraArgs` | `[]` | 追加给 Claude CLI 的参数 |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` / `silent` |

通用环境变量：

| 变量 | 说明 |
|---|---|
| `A2S_CONFIG_PATH` | 完整共享配置路径 |
| `A2S_CONFIG_DIR` | 共享配置目录 |
| `A2S_ENDPOINTS` | 覆盖服务器端点，逗号分隔 |
| `A2S_KEY` | 覆盖设备 key |
| `CLAUDE2SERVER_ENDPOINT` | 只覆盖 Claude 端点 |
| `CLAUDE2SERVER_KEY` | 只覆盖 Claude key |
| `CLAUDE_EXE` | 覆盖 Claude 可执行文件 |
| `CLAUDE_CONFIG_DIR` | 覆盖 Claude Code 原生配置/历史目录 |

优先级为：程序化 overrides ＞ `--config` 文件 ＞ Agent 环境变量/共享配置中的 Agent 字段 ＞共享配置的通用字段。

### 语言

推荐在 A2Switch 的“统一配置 → Claude Code → 插件语言”中切换。无 A2Switch 时可编辑 `agents.claude.locale`，或用 `--locale system|zh-CN|en-US` 临时覆盖。桥接器会把最终解析语言上报给 server-api，并用它生成插件侧状态说明；A2Switch 与云端控制台仍各自保留独立的界面语言设置。

## 会话实现

每个 A2S Claude 会话对应一个按需启动的 Claude Code 进程：

```text
claude -p --input-format stream-json --output-format stream-json
       --verbose --include-partial-messages
```

- 首次提示时启动，后续提示复用 stdin/stdout。
- Claude 返回原生 session ID 后会记录；进程重建时用 `--resume` 恢复。
- 会话索引与有限事件窗口保存到共享配置目录的 `claude-sessions.json`。
- 启动时扫描 Claude Code 原生 `projects/*/*.jsonl` 历史，按原生 session ID 与 A2S 会话重新关联；正文只在首次打开该会话时按需转换，避免启动阶段一次性读取全部历史。
- 原生 `user`、`assistant`、`thinking`、`tool_use` 与 `tool_result` 记录会转换为统一的 turn/message/tool 事件，因此桥接器重启后仍能在 server-api 查看旧对话。
- `claude-sessions.json` 保存最近 2,000 条事件作为快速恢复窗口，原生 JSONL 仍是完整历史来源；单次内存窗口上限为 20,000 条事件。
- 每次提示都会携带稳定的 `clientMessageId`/`requestId`；Claude `stream-json` 回传的输入回显会被消费，只保留一条持久用户消息，避免控制台出现重复气泡。
- 退出时关闭子进程并刷新会话索引。
- 运行状态写入 `runtime/claude.json`，供 A2Switch 汇总。

## 统一方法

| 类别 | 方法 |
|---|---|
| 实例 | `instance.info`、`instance.health`、`instance.key` |
| 会话 | `session.list`、`session.create`、`session.get`、`session.prompt`、`session.interrupt`、`session.cancel` |
| 历史 | `session.history`、`session.events` |
| 管理 | `session.rename`、`session.fork`、`session.archive` |
| 模型/权限 | `session.modelCatalog`、`session.selectModel`、`session.approvalPolicy`、`session.permission` |
| 工作区/命令 | `workspace.list/create/rename/remove`、`workspace.fs.roots/list/read/mkdir`、`command.run` |

事件统一为 `turn/start`、`user/message`、`assistant/message`、流式 assistant 片段、`turn/end` 和 session status 等 A2S/dsh 兼容结构，因此 server-api 的同一个控制台可以渲染 Claude、Codex 和 DSH。

模型选择同时保存用户请求值（例如 `sonnet`）与 Claude Code 初始化后报告的实际模型 ID（例如 `claude-sonnet-4-6`）；控制台优先显示实际执行模型。运行中的思考强度通过 Claude 控制协议动态更新，新进程则使用 `--effort` 启动参数。

工作区既可以显式登记，也可以由已有会话目录推导。推导出的工作区同样支持重命名和“从列表移除”；移除只写入隐藏登记，不删除磁盘目录，也不会因为下一次刷新仍有旧会话而自动重新出现。再次创建同一路径会解除隐藏。

## 权限模式映射

| A2S preset | Claude permission mode |
|---|---|
| `read-only` | `plan` |
| `workspace-write` | `default` / `acceptEdits` / `dontAsk` |
| `full-access` | `bypassPermissions` |

当前桥接器可以远程选择权限模式，但不转发 Claude CLI 内部的逐工具审批或结构化提问，因此能力位 `approvalAnswer` 与 `questions` 为 `false`。需要无人值守时应明确选择合适的 Claude 权限模式，并理解其安全影响。

## 传输与重连

- `transport: auto`：优先 WebSocket，失败后切换 HTTP 长轮询；
- `transport: ws`：只使用 WebSocket；
- `transport: http`：只使用 `/events` 和 `/inbox`；
- 每个端点独立连接与指数退避重连；
- 事件带单调序号和有限重放缓冲，服务器可在重连后要求补发；
- 心跳与超时信息写入 runtime 状态。

## 测试

```powershell
npm test
npm run check
npm run doctor
```

其中包含 Claude `stream-json` 输入回显去重、请求关联 ID、原生 JSONL 历史发现/转换，以及推导工作区新建、重命名、移除和恢复的回归测试。

仓库级真实模型测试：

```powershell
cd D:\Project\A2S
node .\scripts\full-loop-test.mjs
```

该测试会由 server-api 创建 Claude 会话、下发唯一标记提示词并等待真实 Claude Code 返回结果，之后自动清理会话和桥接进程。

## 目录结构

```text
cc2server/
├─ bin/cc2server.js          CLI
├─ index.js                  配置装配与应用工厂
├─ lib/claude-adapter.js     A2S 方法适配
├─ lib/claude-session.js     stream-json 子进程与事件转换
├─ lib/claude-history.js     原生 Claude JSONL 历史发现与按需转换
├─ lib/session-store.js      本机会话索引与快速恢复事件窗口
├─ lib/workspace-store.js    工作区登记、标题与隐藏状态
├─ lib/a2s/                  统一协议、配置和传输客户端
└─ test/                     单元测试
```

`package-lock.json` 固定当前安装图，建议 CI 使用 `npm ci`。当前生产依赖审计为 0 个已知漏洞。

## 许可证

MIT，见 `LICENSE`。Claude 与 Claude Code 是 Anthropic 的商标；本项目是独立的兼容桥接器。

---

## English

`cc2server` connects local Claude Code to an A2S relay. Unified server methods are mapped to Claude Code's structured `stream-json` input/output protocol, while sessions, assistant output, runtime state, errors, tools, and usage are emitted in the shared A2S event model. The bridge only makes outbound connections; no workstation port is opened.

### Requirements and installation

- Node.js 22 or newer.
- An installed and authenticated `claude` CLI.
- A registered A2S device key and server endpoint, normally managed by A2Switch.

The recommended path is A2Switch's **Install/update all** action. For development:

```powershell
npm install
node .\bin\cc2server.js doctor
node .\bin\cc2server.js start --shared-config "$env:APPDATA\A2S\config.json"
```

`doctor` checks Node, Claude discovery/version, shared configuration, endpoint normalization, credentials, and server reachability without printing complete secrets.

### Configuration

The bridge reads the shared A2Switch configuration by default. `A2S_CONFIG_PATH` may select another file. Environment/CLI options can override endpoints, transport (`auto`, `websocket`, or `http`), locale (`system`, `zh-CN`, or `en-US`), executable, working directory, heartbeat, reconnect policy, and optional terminal capability. Never commit real device keys.

### Session model

Each active A2S session owns a persistent Claude `stream-json` subprocess. Prompts are written to stdin and events are parsed continuously. Native Claude JSONL history is discovered and converted on demand, while a local session index and bounded event window support fast recovery. Workspaces can be registered, renamed, hidden, and filtered independently of disk deletion.

### Unified methods

The adapter covers instance information/health, session list/create/history/prompt/interrupt/rename/fork/archive, workspace listing/management, model and permission settings, approvals/questions when exposed by Claude, restricted file browsing, event replay/subscription, and optional terminal operations. Unsupported capabilities are omitted from the negotiated method catalog rather than simulated.

Claude permission modes are mapped to the common A2S permission model. Path access is constrained to approved workspace roots, attachment/file payloads are bounded, and terminal access remains disabled unless explicitly enabled.

### Transport and recovery

WebSocket is attempted first in `auto` mode. Authentication or protocol failures are treated as fatal; network/upgrade failures back off with jitter and may fall back to HTTP long polling. Heartbeats, runtime records, monotonic event sequences, and replay watermarks prevent a temporary disconnect from losing active-session output.

### Tests

```powershell
npm test
npm run check
```

Tests cover configuration, protocol framing, transport fallback/reconnect, runtime records, session control, history conversion, workspaces, files, approvals, and security boundaries. `package-lock.json` pins the install graph; CI should use `npm ci`.

### License

MIT. Claude and Claude Code are Anthropic trademarks. This project is an independent compatibility bridge and is not endorsed by Anthropic.
