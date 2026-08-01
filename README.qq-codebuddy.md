# QQ 官方机器人 × 编程 CLI 部署说明

> 本文说明当前 Fork 中的 QQ 官方机器人桥接：QQ 群聊/私聊消息进入配置的编程 CLI，并按配置复用原生会话。当前支持 CodeBuddy、Codex 和 Claude Code。
>
> 这是独立于原项目飞书/Lark 通道的 PoC 桥接，入口为 `src/qq-daemon.ts`。

## 1. 当前能力与边界

已实现：

- QQ 官方 Gateway WebSocket 接入：Access Token、鉴权、心跳和断线重连；
- QQ 私聊消息与群内 `@机器人` 消息；
- CodeBuddy、Codex、Claude Code 的可配置 Runner；CodeBuddy/Claude 使用结构化流式输出，Codex 使用 `exec --json`；
- 私聊/群聊消息来源、发送者稳定 ID、owner 身份注入；
- 同一个会话范围内的任务串行；
- 群聊任务超过 3 秒时先回复“正在处理…”，随后发送最终结果；
- 同一群或私聊的机器人出站消息串行，并强制至少间隔 1 秒；
- PM2 守护运行；
- 运行日志包含入站事件、任务开始/完成/失败及 QQ 出站消息 ID。

尚未实现：附件与图片、引用消息解析、`/cancel`、权限确认桥接、数据库审计、沙盒/worktree、Markdown/文件回传和跨机器人协作路由。

## 2. 前置条件

- Linux；
- Node.js `>=22`；
- `pnpm@9.5.0`；
- 已安装并登录 CodeBuddy Code CLI；
- QQ 开放平台已创建官方机器人，已获得 `AppID`、`AppSecret`；
- QQ 开放平台已启用群聊和私聊能力，并订阅/授予群聊与单聊消息事件权限；
- 可访问 QQ 官方 API 与 Gateway。

验证本机依赖：

```bash
node --version
/data/home/bojuchen/.local/bin/codebuddy --version
```

## 3. 获取与安装项目

```bash
git clone https://github.com/deepcoldy/botmux.git ~/ai/botmux
cd ~/ai/botmux
npx --yes pnpm@9.5.0 install --frozen-lockfile
```

当前 Fork 需要包含以下 QQ 接入文件：

```text
src/qq-daemon.ts
src/im/qq/client.ts
src/im/qq/event-dispatcher.ts
```

并且 `package.json` 中应有：

```json
"daemon:qq": "tsx src/qq-daemon.ts"
```

类型检查：

```bash
npx --yes pnpm@9.5.0 exec tsc --noEmit
```

## 4. QQ 开放平台配置

在 QQ 开放平台创建机器人后，记录：

- `AppID`；
- `AppSecret`；
- 群聊和私聊消息能力；
- Gateway 事件权限。

本桥接监听 QQ 官方 `GROUP_AND_C2C_EVENT (1 << 25)` intent 下的：

- `GROUP_AT_MESSAGE_CREATE`：群内 @ 机器人；
- `C2C_MESSAGE_CREATE`：用户私聊机器人。

首次调试建议使用 QQ 平台 Sandbox/测试群，并先验证机器人能被群成员 @。

## 5. 私密配置

创建配置目录和文件：

```bash
mkdir -p ~/.botmux
chmod 700 ~/.botmux
nano ~/.botmux/qq.json
chmod 600 ~/.botmux/qq.json
```

示例：

```json
{
  "appId": "你的QQ机器人AppID",
  "appSecret": "你的QQ机器人AppSecret",
  "cliId": "codebuddy",
  "cliPath": "/data/home/用户名/.local/bin/codebuddy",
  "model": "hy3-ioa",
  "effort": "max",
  "permissionMode": "default",
  "sessionScope": "bot",
  "workingDir": "/data/home/用户名/ai",
  "allowedUsers": ["*"],
  "ownerUsers": ["你的QQ member_openid"]
}
```

不要将此文件提交到 Git，也不要把 `AppSecret` 写入项目 `.env.example`、README 或源码。

### 配置字段

| 字段 | 必填 | 说明 |
|---|---:|---|
| `appId` | 是 | QQ 开放平台机器人 AppID。 |
| `appSecret` | 是 | QQ 开放平台机器人 AppSecret。 |
| `cliId` | 否 | `codebuddy`、`codex` 或 `claude-code`；缺省为 `codebuddy`。 |
| `cliPath` | 新配置必填 | 所选 CLI 的绝对路径或 PATH 中的命令名。旧配置可继续使用 `codebuddyPath`。 |
| `codebuddyPath` | 兼容字段 | 旧版 CodeBuddy CLI 路径；新配置请使用 `cliPath`。 |
| `model` | 否 | 所选 CLI 的模型参数；CodeBuddy 缺省 `hy3-ioa`。 |
| `effort` | 否 | 推理强度，默认 `max`。 |
| `permissionMode` | 否 | CodeBuddy 权限模式。当前桥接代码固定传递 `default`；此字段已预留，接入外部沙盒后再启用为 `bypassPermissions`。 |
| `workingDir` | 是 | CodeBuddy 的工作目录。 |
| `allowedUsers` | 是 | 可用用户的 `member_openid` 数组；`["*"]` 表示开放给所有用户，仅建议测试使用。 |
| `ownerUsers` | 否 | 机器主人的 `member_openid` 数组。仅用于向 Agent 注入可信身份与协作者谨慎操作提示，不会拒绝其他用户。 |
| `sessionScope` | 否 | 会话复用范围，见下表。 |

### `sessionScope` 模式

| 值 | 行为 |
|---|---|
| `conversation` | 默认。每个私聊、每个群各自一个 CodeBuddy Session。 |
| `user` | 同一用户无论私聊或在哪个群内发言，都复用其个人 Session；不同用户隔离。 |
| `bot` | 整个 QQ 机器人只使用一个共享 Session。所有用户、所有群和私聊按到达顺序串行进入同一上下文。 |

切换 `sessionScope` 或 `cliId` 后建议重启服务。会话映射按 CLI 隔离，切换 CLI 会新建独立会话；不要让不同 CLI 共用同一原生会话 ID。测试时可直接编辑 `~/.botmux/qq-sessions.json` 选择迁移复用的会话；生产环境应使用数据库迁移，不建议手工编辑。

### CLI 配置示例

```json
// CodeBuddy
{ "cliId": "codebuddy", "cliPath": "/data/home/用户名/.local/bin/codebuddy", "model": "hy3-ioa", "effort": "max" }

// Codex
{ "cliId": "codex", "cliPath": "codex", "model": "gpt-5-codex" }

// Claude Code
{ "cliId": "claude-code", "cliPath": "claude", "model": "sonnet" }
```

Codex 与 Claude Code 必须先在部署机完成各自的安装与登录。当前机器未检测到它们的可执行文件，因此本次只验证了 Runner 的类型检查；切换前请自行执行 `codex --version` 或 `claude --version`。

## 6. 启动与守护

前台调试：

```bash
cd ~/ai/botmux
npx --yes pnpm@9.5.0 daemon:qq
```

推荐 PM2：

```bash
cd ~/ai/botmux
npx --yes pnpm@9.5.0 exec pm2 start ./node_modules/tsx/dist/cli.mjs \
  --name botmux-qq \
  --interpreter "$(command -v node)" \
  -- src/qq-daemon.ts
npx --yes pnpm@9.5.0 exec pm2 save
```

常用运维命令：

```bash
cd ~/ai/botmux

npx --yes pnpm@9.5.0 exec pm2 status botmux-qq
npx --yes pnpm@9.5.0 exec pm2 logs botmux-qq
npx --yes pnpm@9.5.0 exec pm2 restart botmux-qq
npx --yes pnpm@9.5.0 exec pm2 stop botmux-qq
npx --yes pnpm@9.5.0 exec pm2 delete botmux-qq
```

需要系统开机自启时，按 PM2 输出执行一次 `pm2 startup` 给出的系统命令；随后再次执行 `pm2 save`。

## 7. 运行机制

1. QQ Gateway 接收私聊或群内 @ 事件；
2. 桥接记录入站事件：事件 ID、对话、发送人和正文长度；
3. 根据 `sessionScope` 选择 CodeBuddy 原生会话 ID；
4. 在 prompt 中注入可信的发送者 ID、owner/协作者角色和来源（群/私聊）；
5. 以 `codebuddy --print --output-format stream-json --resume ...` 执行本轮；
6. 仅提取结构化输出里的 `assistant` 文本；
7. 群聊慢任务先回“正在处理…”，随后回最终结果；
8. 出站消息按群或私聊串行化，间隔至少 1 秒。

`sessionScope: "bot"` 时，全员共享同一个 Agent 上下文。务必确保 Agent 可从每条系统注入字段识别当前发言人，避免把不同成员的意见混淆。

## 8. 日志与排障

PM2 日志：

```bash
~/.pm2/logs/botmux-qq-out.log
~/.pm2/logs/botmux-qq-error.log
```

查看最近任务：

```bash
grep -E 'inbound received|turn (started|completed|failed)|outbound delivered' \
  ~/.pm2/logs/botmux-qq-out.log | tail -100
```

关键日志字段：

- `inbound received`：QQ 已将消息送达桥接；
- `turn started` / `turn completed`：CodeBuddy 已开始/完成；
- `outbound delivered`：QQ API 已接受回复，记录了回复消息 ID；
- `turn failed`：CodeBuddy 或消息回传失败，需查看 error log。

常见问题：

| 现象 | 排查方向 |
|---|---|
| 机器人不收消息 | 检查 QQ 平台消息事件权限、Sandbox/正式环境、Gateway `ready` 日志。 |
| 群内无回复 | 确认是 @ 机器人；查看 `inbound received`、`turn completed` 与 `outbound delivered` 是否齐全。 |
| 只出现“正在处理…” | 查看 `turn failed` 和 PM2 error log；CodeBuddy 可能无响应或退出。 |
| 多人同时问有消息不显示 | 检查每条事件是否都有 `outbound delivered`；桥接已对同一对话出站间隔 1 秒。 |
| CodeBuddy 无法恢复上下文 | 检查 `~/.botmux/qq-sessions.json` 与 `~/.codebuddy/projects/`；必要时删除对应映射以创建新 Session。 |
| Gateway 周期性断开 | QQ Gateway 会发生连接生命周期轮换；只要随后出现 `gateway ready` 即代表已自动恢复。 |

## 9. 安全说明

- `allowedUsers: ["*"]` 仅适合短期测试；生产应使用明确的 `member_openid` 白名单；
- `ownerUsers` 只是 Agent 的身份上下文，不是操作系统安全隔离；
- Session 隔离不等于文件系统隔离；
- 在未完成容器/沙盒隔离前，不要对不可信用户开启可写工作区或 `bypassPermissions`；
- 生产建议：每任务/用户独立 sandbox 或 Git worktree、受限网络、挂载目录白名单、资源配额和审计存储；
- 不要在 QQ 中回传 Token、密码、`.env` 内容、SSH 私钥或完整敏感日志。

## 10. 相关文件

```text
src/qq-daemon.ts               QQ → CodeBuddy 主桥接
src/im/qq/event-dispatcher.ts  QQ Gateway 事件接入
src/im/qq/client.ts            QQ Access Token 与消息发送 API
~/.botmux/qq.json              私密运行配置
~/.botmux/qq-sessions.json     会话映射
~/.pm2/logs/botmux-qq-*.log    PM2 运行日志
```
