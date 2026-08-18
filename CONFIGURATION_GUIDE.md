# MULTIBOT 配置说明书

这份文档按 `MULTIBOT` 当前代码实现整理，目标是把现有所有主要配置入口、合并规则、默认值和注意事项放到一处，方便你像查 MCC 的配置文档一样查 JSON 配置。

如果只想先抓大方向，先记住这几条：

- 后端总配置看 `MULTIBOT/multibot.config.json`
- 同服共享连接配置看 `MULTIBOT/BOTS/<serverDir>/server.json`
- 同服共享 bot 默认配置看 `MULTIBOT/BOTS/<serverDir>/default.config.json`
- 单 bot 自己的配置看 `MULTIBOT/BOTS/<serverDir>/<botDir>/config.json`
- legacy 显式 bot 仍使用 `ASSN/<accountDir>/config.json`

---

## 1. 配置体系总览

### 1.1 文件分层

`MULTIBOT` 现在实际有两套配置平面：

- **后端 / 进程级配置**
  - 放在 `multibot.config.json`
  - 控制 API、日志、实例发现、全局默认运行时字段等
- **bot / 实例级配置**
  - 放在 `server.json`、`default.config.json`、`config.json`
  - 控制连接参数、白名单、录制、攻击、监控、日志等 bot 行为

### 1.2 目录结构

推荐的 `BOTS` 结构：

```text
MULTIBOT/
  BOTS/
    ASSN/
      server.json
      default.config.json
      example_bot/
        config.json
        whitelist.txt
      example_trusted/
        config.json
        whitelist.txt
```

legacy 显式 bot 则仍然是：

```text
ASSN/
  example_bot/
    config.json
    whitelist.txt
```

### 1.3 两类“默认配置”不要混淆

- `multibot.config.json -> defaults`
  - 只适合放 **运行时连接字段**
  - 例如 `host`、`port`、`restartDelayMs`
- `BOTS/<serverDir>/default.config.json`
  - 适合放 **bot 功能配置**
  - 例如 `teleport`、`recording`、`logging`、`capabilities`

如果你想给全服 bot 共享 `teleport` / `recording` / `logging` 默认值，应该写到 `default.config.json`，不是写到 `multibot.config.json.defaults`。

### 1.4 合并优先级

#### 运行时字段

运行时字段包括：

- `id`
- `enabled`
- `autoStart`
- `host`
- `port`
- `auth`
- `version`
- `username`
- `email`
- `viewDistance`
- `disableChatSigning`
- `checkTimeoutInterval`
- `restartOnDisconnect`
- `restartDelayMs`
- `restartJitterMs`

对于 `BOTS/<serverDir>/<botDir>` 结构实例，优先级是：

1. 代码内建默认值
2. `multibot.config.json -> defaults`
3. `server.json`
4. `server.json -> connection`
5. `default.config.json` 顶层同名字段
6. `config.json` 顶层同名字段

对于 `multibot.config.json -> bots[]` 显式 legacy bot，优先级更简单：

1. 代码内建默认值
2. `multibot.config.json -> defaults`
3. `multibot.config.json -> bots[]` 当前项

#### bot 功能字段

bot 功能字段主要由 `loadLegacyBotConfig()` 负责，优先级是：

1. 代码内建 legacy 默认值
2. `default.config.json`
3. `config.json`

legacy 显式 bot 没有 `default.config.json` 时，就只剩：

1. 代码内建 legacy 默认值
2. `ASSN/<accountDir>/config.json`

### 1.5 路径解析规则

- `multibot.config.json` 里的日志路径
  - 例如 `diagnostics.memoryLogger.filePath`
  - 相对路径按 `MULTIBOT` 根目录解析
- `config.json` / `default.config.json` 里的 bot 文件路径
  - 例如 `teleport.whitelistFile`
  - `logging.logFilePath`
  - `recording.outputDir`
  - 相对路径按 **该 bot 账号目录** 解析
- 聚合日志路径不是配置项，固定写到：
  - `MULTIBOT/BOTS/<serverDir>/<serverDir>_chat.log`
  - `MULTIBOT/BOTS/<serverDir>/<serverDir>_playerList.log`

---

## 2. `multibot.config.json`

这是后端主配置文件。

### 2.1 `api`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `api.host` | string | `127.0.0.1` | API 监听地址 |
| `api.port` | integer | `18080` | API 监听端口 |
| `api.token` | string | 无 | API Token，必填 |
| `api.allowedOrigins` | string[] | 本机面板地址 | 允许浏览器跨域访问 API 的完整 Origin 白名单 |
| `api.bodyLimitBytes` | integer | `1048576` | JSON 请求体最大字节数，超限返回 `413` |
| `api.maxSseClients` | integer | `32` | SSE 客户端连接上限，超限返回 `429` |

说明：

- `api.token` 缺失时，后端会直接报错启动失败
- 如果要暴露公网，建议前面加 Nginx / SSL / 访问控制，而不是只靠 token

### 2.2 `protocolGuard`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `protocolGuard.enabled` | boolean | `true` | 协议热修复总开关 |
| `protocolGuard.ignoreMalformedNbtArrayPackets` | boolean | `true` | 忽略某类已知畸形包 |
| `protocolGuard.burstLimit` | integer | `20` | 短窗口内允许的异常包数量 |
| `protocolGuard.burstWindowMs` | integer | `60000` | 异常包计数窗口，单位毫秒 |
| `protocolGuard.logParseErrors` | boolean | `true` | 是否打印解析错误日志 |

说明：

- 这是 `mineflayer` 协议层热修复相关配置
- 当前仓库模板里通常会把 `logParseErrors` 关掉来降低噪声，但代码默认仍是 `true`

### 2.3 `diagnostics`

#### `diagnostics.memoryLogger`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `diagnostics.memoryLogger.enabled` | boolean | `false` | 是否启用进程内存采样日志 |
| `diagnostics.memoryLogger.intervalMs` | integer | `10000` | 采样间隔，毫秒 |
| `diagnostics.memoryLogger.filePath` | string | `./logs/memory-monitor.log` | 输出文件，相对 `MULTIBOT` 根目录 |

#### `diagnostics.memoryDetails`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `diagnostics.memoryDetails.enabled` | boolean | `false` | 是否启用每个 bot 的详细内存诊断、区块包计数和 `GET /api/diagnostics/memory` |

说明：

- `memoryLogger.enabled` 只控制进程级内存采样日志是否写文件。
- `memoryDetails.enabled` 控制更细的 per-bot 诊断。关闭时，内存日志仍会记录 bot 状态摘要，但不会拉取 `worldColumns`、实体数量、玩家数量、区块包计数等详细字段，`GET /api/diagnostics/memory` 会返回禁用状态。
- 这个开关默认关闭；排查内存问题时再临时打开。

#### `diagnostics.apiAccessLogger`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `diagnostics.apiAccessLogger.enabled` | boolean | `true` | 是否记录 HTTP 访问日志 |
| `diagnostics.apiAccessLogger.filePath` | string | `./logs/api-access.log` | 输出文件，相对 `MULTIBOT` 根目录 |
| `diagnostics.apiAccessLogger.logToConsole` | boolean | `false` | 是否同步打印到后端控制台 |
| `diagnostics.apiAccessLogger.includeHeaders` | boolean | `true` | 是否记录脱敏后的请求头 |
| `diagnostics.apiAccessLogger.includeBodyPreview` | boolean | `false` | 是否记录脱敏后的请求正文预览；默认不记录正文 |

说明：

- API 访问日志会记录合法访问，也会记录 401 / 404 / 405 / 畸形请求等

#### `diagnostics.lifecycleLogger`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `diagnostics.lifecycleLogger.enabled` | boolean | `true` | 是否记录实例生命周期日志 |
| `diagnostics.lifecycleLogger.filePath` | string | `./logs/lifecycle.log` | 输出文件，相对 `MULTIBOT` 根目录 |
| `diagnostics.lifecycleLogger.logToConsole` | boolean | `false` | 是否同步打印到后端控制台 |

说明：

- 记录每个 bot 实例的加入（`bot_spawn`）、断开（`bot_disconnect`，含原因：`disconnect` / `kicked` / `backend_unavailable` / `invalid_session_retry` 等）、重启调度（`bot_restart_scheduled`）、停止（`bot_stop`）、启动失败（`bot_start_failed`）以及进程级崩溃（`process_crash` / `process_unhandled_rejection`）事件
- 每条为一行 JSON，字段含 `time` / `event` / `botId` / `serverDir` / `reason` / `detail`

### 2.4 `aggregateLogging`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `aggregateLogging.enabled` | boolean | `false` | 聚合日志总开关 |
| `aggregateLogging.chat` | boolean | `true` | 是否启用聊天聚合 |
| `aggregateLogging.playerList` | boolean | `true` | 是否启用玩家列表聚合 |
| `aggregateLogging.chatBatchWindowMs` | integer | `100` | 同服同消息去重窗口，毫秒 |
| `aggregateLogging.playerListIntervalMinutes` | number | `1` | 聚合玩家列表写入周期，分钟 |

说明：

- 只对 `MULTIBOT/BOTS/<serverDir>/<botDir>` 实例生效
- legacy 显式 bot 不参与聚合
- 如果单实例日志也开着，会双写

### 2.5 `defaults`

`defaults` 不是任意 JSON 仓库，而是 **运行时字段默认值**。

支持字段见下文 “第 3 节 运行时字段一览”。

常见用途：

- 给所有 bot 统一默认 `auth`
- 统一 `version`
- 统一 `disableChatSigning`
- 统一 `restartDelayMs` / `restartJitterMs`

不建议放在这里的内容：

- `teleport`
- `logging`
- `recording`
- `capabilities`

这些应该放在 `default.config.json`。

### 2.6 `discovery`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `discovery.enabled` | boolean | `true` | 是否扫描 `BOTS` 目录自动发现实例 |
| `discovery.botsRoot` | string | `./BOTS` | 实例扫描根目录，相对 `MULTIBOT` 根目录 |

### 2.7 `bots[]`

这是显式 bot 列表，适合：

- legacy `ASSN/<accountDir>` 结构
- 不想走 `BOTS` 自动发现的特殊实例

每项支持两种定位方式：

#### 方式 A：legacy 账号目录

```json
{
  "accountDir": "example_bot"
}
```

#### 方式 B：`BOTS` 实例目录

```json
{
  "serverDir": "ASSN",
  "botDir": "example_bot"
}
```

除此之外，还支持“第 3 节”的所有运行时字段，例如：

- `id`
- `enabled`
- `autoStart`
- `host`
- `port`
- `username`
- `email`
- `restartDelayMs`
- `restartJitterMs`

注意：

- `bots[]` 本身不承载 `teleport` / `recording` 这类 legacy 功能配置
- 这些功能配置仍然来自 bot 自己的 `config.json`

---

### 2.8 `consoleConnector`

这个配置块也是写在 `multibot.config.json` 顶层，用来控制“单实例瘦终端连接器”首次接入时能拿到多少历史日志。

```json
{
  "consoleConnector": {
    "historyLimit": 300
  }
}
```

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `consoleConnector.historyLimit` | integer | `300` | 单个连接器首次接入某个 bot 时，后端返回的历史日志最大条数 |

说明：

- 这是 **后端配置**，不是 bot 配置
- 缺省值是 `300`
- 非法值、`0`、负数都会回落到 `300`
- 这个值只影响 `GET /api/bots/:id/console-stream` 的 `bootstrap.logs`
- 为了保证历史日志够用，runtime logger ring buffer 会至少保留 `max(500, historyLimit)` 条

连接器启动方式固定为命令行参数：

```powershell
node .\console-connector.js --bot-id example_bot --api-base http://127.0.0.1:18080 --token change-me
```

可选参数：

- `--sender <name>`
  - 默认 `panel_connector`

当前明确不支持：

- 环境变量读取 `apiBase`
- 环境变量读取 `token`
- 本地连接器配置文件

## 3. 运行时字段一览

这一节的字段可出现在以下位置：

- `multibot.config.json -> defaults`
- `multibot.config.json -> bots[]`
- `server.json`
- `server.json -> connection`
- `default.config.json` 顶层
- `config.json` 顶层

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 自动生成 | bot 唯一 ID；未写时自动拼成 `<serverDir>__<botDir>` 或 `legacy__<accountDir>` |
| `enabled` | boolean | `true` | 是否启用该实例 |
| `autoStart` | boolean | `false` | 后端启动时是否自动启动该 bot |
| `host` | string | 无 | 服务器地址 |
| `port` | integer | `25565` | 服务器端口 |
| `auth` | string | `microsoft` | 登录模式，通常是 `microsoft` |
| `version` | string / boolean | `false` | Minecraft 版本；`false` 表示交给底层自动处理 |
| `username` | string | `email` | 登录用户名；未写时回落到 `email` |
| `email` | string | `username` | Microsoft 登录邮箱；未写时回落到 `username` |
| `viewDistance` | string | `tiny` | 登录时请求的视距 |
| `disableChatSigning` | boolean | `true` | 是否关闭聊天签名 |
| `checkTimeoutInterval` | integer | `30000` | 客户端等待服务端 keepalive 的本地超时时间，毫秒 |
| `restartOnDisconnect` | boolean | `true` | 断线后是否自动重连 |
| `restartDelayMs` | integer | `60000` | 重连基础延迟，毫秒 |
| `restartJitterMs` | integer | `120000` | 断线重连随机附加延迟上限，毫秒 |
| `restartDelayScheduleMs` | integer[] | 无（未启用） | 可选的分级重连基础延迟数组，毫秒；只从 `server.json` 顶层读取 |
| `restartDelayScheduleRepeatLast` | boolean | `true` | 分级数组耗尽后是否重复最后一级；只从 `server.json` 顶层读取 |

`openAuth` 是例外字段：它只读取 `BOTS/<serverDir>/server.json` 顶层，不属于 `multibot.config.json -> defaults`、`default.config.json`、单 bot `config.json` 或面板可编辑字段。

### 3.1 关于随机重连

当前重连模型是：

```text
实际重连延迟 = restartDelayMs + random(0..restartJitterMs)
```

默认值：

- `restartDelayMs = 60000`
- `restartJitterMs = 120000`

也就是 **默认常规断线后会在 60 ~ 180 秒之间随机重连**。

注意：

- 只作用于普通 `disconnect`
- 不作用于 `autoStart`
- 不作用于 `invalid_session_retry`
- 不作用于 `retryable_error`
- 不作用于手动 `restart`

#### 可选的分级重连

同服可以在 `server.json` 顶层配置分级延迟数组，例如：

```json
{
  "restartDelayMs": 60000,
  "restartDelayScheduleMs": [
    60000,
    300000,
    600000,
    900000,
    1800000,
    3600000,
    7200000
  ],
  "restartJitterMs": 120000,
  "restartDelayScheduleRepeatLast": true
}
```

语义：

- `restartDelayScheduleMs`：可选的分级基础延迟数组，毫秒，允许值为 `0`；**缺省表示未启用分级策略**。
- 第一次自动重连使用数组第一项，第二次使用第二项，依此类推。
- 每一级实际延迟 = 当前级基础延迟 + `random(0..restartJitterMs)`。
- `restartDelayScheduleRepeatLast`：
  - `true`（默认）：数组耗尽后重复最后一个值。
  - `false`：数组内的重连次数全部失败后停止，不再安排下一次。
- 数组有 7 项且 `restartDelayScheduleRepeatLast=false` 时，最多安排 7 次分级自动重连；第 7 次仍未成功 `spawn`，下一次调度时进入耗尽停止状态。
- ViaProxy 后端不可达和普通断线共用同一套延迟策略：配置了数组就按分级，没有配置就沿用 `restartDelayMs + restartJitterMs`。
- `restartOnDisconnect: false` 优先级最高，直接禁止自动重连。

严格校验：

- 字段一旦存在，必须是非空数组，每个元素必须是大于等于 0 的整数（`Number.isInteger`）。
- 空数组、负数、小数、数字字符串和非数组值都会返回明确配置错误，不会截断或静默忽略。
- `restartDelayScheduleRepeatLast` 缺省为 `true`；字段存在时必须是布尔值。

这两个新字段只从 `server.json` 顶层读取，同一服务器目录下所有 Bot 共享，Bot 配置不能覆盖；旧的 `restartOnDisconnect`、`restartDelayMs` 和 `restartJitterMs` 保持现有合并优先级不变。

### 3.2 关于 KeepAlive 超时

`checkTimeoutInterval` 会被传入 `mineflayer.createBot()`，并继续透传给 `minecraft-protocol` 的客户端 keepalive 模块。

它影响的是本地客户端在收到服务端 keep_alive 后，等待下一次 keep_alive 的超时判断。默认 `30000` 表示 30 秒。

如果日志里出现：

```text
client timed out after 30000 milliseconds
```

可以把它调大，例如：

```json
{
  "connection": {
    "checkTimeoutInterval": 120000
  }
}
```

这不能保证解决 `read ECONNRESET`，因为 `ECONNRESET` 通常是服务端、代理或网络链路主动重置连接。

### 3.3 `server.json` 推荐写法（直连）

`server.json` 更适合同服共享字段，例如：

```json
{
  "host": "example.org",
  "port": 25565,
  "version": "1.21.11",
  "auth": "microsoft",
  "viewDistance": "tiny",
  "disableChatSigning": true,
  "checkTimeoutInterval": 30000,
  "restartOnDisconnect": true,
  "restartDelayMs": 60000,
  "restartDelayScheduleMs": [
    60000,
    300000,
    600000,
    900000,
    1800000,
    3600000,
    7200000
  ],
  "restartJitterMs": 120000
}
```

也兼容：

```json
{
  "connection": {
    "host": "example.org",
    "port": 25565,
    "checkTimeoutInterval": 120000,
    "restartDelayMs": 60000,
    "restartJitterMs": 120000
  }
}
```

#### 传送请求文本匹配

不同服务器插件可能使用不同的 TPA 提示文本。可在 `server.json` 的 `teleportPromptMatchers` 中为同一服务器下所有 bot 追加匹配规则：

```json
{
  "teleportPromptMatchers": {
    "stripLines": [
      "^使用 /tpaccept 接受，使用 /tpdeny 拒绝。$"
    ],
    "tpa": [
      "^(?<sender>[A-Za-z0-9_]{1,16}) 向你发起了传送申请$"
    ],
    "tpahere": [
      "^(?<sender>[A-Za-z0-9_]{1,16}) 邀请你传送到其位置$"
    ]
  }
}
```

- `stripLines`：匹配并移除单独一行的操作提示，再对剩余文本判断。
- `tpa`：匹配“玩家请求传送到 bot”的完整消息。
- `tpahere`：匹配“玩家邀请 bot 传送过去”的完整消息。
- 自定义规则会追加在内置 EssC 中英文规则之后，不会替换内置规则。
- 每条规则必须以 `^` 开头、以 `$` 结尾；消息前后存在任何未被规则明确允许的文本时都不会匹配。
- `tpa` 和 `tpahere` 必须包含命名捕获组 `(?<sender>...)`，用于提取玩家名。建议使用 `[A-Za-z0-9_]{1,16}`。
- 每组最多 20 条规则，每条最多 500 个字符；非法正则会阻止配置加载并指出具体位置。
- 该配置只允许放在 `server.json`，不从 `default.config.json` 或单 bot `config.json` 读取。

例如 `Somebody: Player 请求传送到你的位置`、`[聊天] Player 想要传送到你这里` 都不会命中内置规则，因为消息开头包含额外内容。

### 3.4 ViaProxy/OpenAuth（26.1.2）

当目标服务器强制使用 `26.1.2`，而当前 Mineflayer 客户端协议为 `1.21.11` 时，可用 ViaProxy 做协议转换，并由 MULTIBOT 的 OpenAuth 客户端使用各 bot 自己的 Microsoft 会话完成目标服认证：

升级后启动首行应为 `MULTIBOT V26.3.6-OpenAuth`；如果仍显示旧版本号，应先检查当前 Git 提交和实际启动目录。

```text
MULTIBOT (1.21.11) -> ViaProxy 127.0.0.1:25568 -> 目标服 26.1.2
```

#### 3.4.1 版本与 ViaProxy 配置

固定使用 Java 17、ViaProxy `3.4.12` 和 ViaProxyOpenAuthMod `1.0.2`：

- [ViaProxy 3.4.12](https://github.com/ViaVersion/ViaProxy/releases/tag/v3.4.12) 已包含 26.2 支持，覆盖 26.1.2。
- [ViaProxyOpenAuthMod 1.0.2](https://github.com/ViaVersionAddons/ViaProxyOpenAuthMod/releases/tag/v1.0.2) 的 JAR 放入 ViaProxy 工作目录的 `plugins/`；替换插件后必须重启。
- ViaProxy 工作目录必须固定；不要从随机目录启动，否则 `plugins/`、`viaproxy.yml` 和日志可能落到另一个目录。也可以设置 `VP_RUN_DIR`。

ViaProxy 的 `viaproxy.yml` 示例：

```yaml
bind-address: 127.0.0.1:25568
target-address: mc.example.com:25565
target-version: 26.1.2
connect-timeout: 8000
proxy-online-mode: false
auth-method: OPENAUTHMOD
chat-signing: false
wildcard-domain-handling: none
ignore-protocol-translation-errors: false
suppress-client-protocol-errors: false
log-ips: false
```

这里的 `target-address` 是实际目标服务器；MULTIBOT 的 `server.json` 要填写 ViaProxy 入口。首次生成配置并启动：

```powershell
cd D:\ViaProxy\server-26.1.2
java -version
java -jar .\ViaProxy-3.4.12.jar config .\viaproxy.yml
```

启动日志至少应出现插件 `Loaded`、`Enabled`，并显示监听 `127.0.0.1:25568`。ViaProxy 未运行、端口冲突、插件缺失或版本不兼容时，MULTIBOT 不会退回直连目标服务器。

#### 3.4.2 `server.json` 字段与锁定规则

```json
{
  "host": "viaproxy.local",
  "port": 25568,
  "auth": "microsoft",
  "version": "1.21.11",
  "openAuth": {
    "enabled": true,
    "requestTimeoutMs": 4500
  },
  "restartOnDisconnect": true,
  "restartDelayMs": 60000,
  "restartJitterMs": 120000
}
```

字段规则：

- `openAuth.enabled`：默认 `false`；必须为 `true` 才启用 OpenAuth。
- `openAuth.requestTimeoutMs`：默认 `4500`，只接受 `1000` 到 `5000` 的整数毫秒值；非法值会阻止配置加载。ViaProxy 插件约等待 6 秒，不要超过 `5000`。
- `openAuth` 只能放在 `server.json` 顶层，不支持放在 `connection`、`default.config.json`、单 bot `config.json` 或 `multibot.config.json`。
- `host`、`port`、`auth`、`version` 必须在 `server.json` 顶层或 `server.json -> connection` 中明确写出；`connection` 中的同名字段优先。启用后这四个字段锁定为服务器共享值，bot 级覆盖不会生效。
- OpenAuth 模式要求 `auth` 精确为 `microsoft`、`version` 精确为 `1.21.11`。这里的版本是 Bot 到 ViaProxy 的客户端版本，不是 ViaProxy `target-version`。
- 不要在 ViaProxy 中为这些 bot 添加 Microsoft 账号；账号会话仍由 MULTIBOT 自己加载。

#### 3.4.3 DNS 与连接安全边界

`host` 的语义是 Bot 连接的 ViaProxy 入口。如果填写域名，运行时每次连接前只做一次 A/AAAA 解析，且：

- 解析必须在 3 秒内完成。
- 所有返回地址都必须是回环地址：IPv4 `127.0.0.0/8` 或 IPv6 `::1`；混入任意公网、内网或未解析地址都拒绝连接。
- 通过校验后优先选择 IPv4，并固定使用已验证 IP 建立 TCP 连接，同时保留原域名写入 Minecraft handshake，避免 DNS 重绑定把 Token 请求导向外部主机。
- 不执行 SRV 查询，不提供可配置的 `connectionIP` 字段；最稳妥的生产值是字面量 `127.0.0.1`。
- ViaProxy 只绑定 `127.0.0.1`，不要改成 `0.0.0.0` 或公网地址。

域名可由 DNS 或 Windows hosts 文件映射，例如把 `viaproxy.local` 指向 `127.0.0.1`。

#### 3.4.4 协议限制与失败行为

- 初次登录通过 `oam:join` login plugin query；重连或协议转移阶段处理对应的 play custom payload。未知频道、畸形数据、重复请求 ID 和过长的 server hash 会被拒绝。
- 当前只覆盖客户端 `1.21.11` 到目标 `26.1.2`；不同客户端版本、离线认证或其他目标版本应继续直连或使用独立方案。
- Mojang 返回 `401/403` 或当前短期 session 不可用时，只删除 MULTIBOT 自有 session，并在 1 秒后通过现有 auth-cache 刷新认证。
- Mojang 返回 `429`、`5xx`、网络错误或超时时保留缓存，返回认证失败并走普通重连退避；不会把 Token 写日志，也不会发送给 ViaProxy。
- 有效 `oam:join` 请求一到达就会清除 10 秒看门狗，不需要等待 Mojang Join 完成；认证请求自身仍受 `requestTimeoutMs` 限制。
- 首次或手动启动时，代理连接后 10 秒内没有发出 `oam:join`，或连接在首个请求前结束，bot 会停止并记录 `OPENAUTH_REQUEST_MISSING`；不会静默退回直连。修复 ViaProxy 监听、插件或目标地址后需要手动启动 bot。
- bot 至少成功 `spawn` 一次后，由自动重连发起的新连接如果遇到相同的请求缺失或提前结束，会把原因记为 `openauth_request_missing`，并按服务器配置的普通断线重连策略处理。`restartOnDisconnect: false` 时仍停止；分级数组耗尽且 `restartDelayScheduleRepeatLast: false` 时也停止。
- 缺少签名且没有未签名内容标记的 `player_chat` 会在 `minecraft-protocol` 验签前被规范化为未签名消息，正文仍继续进入聊天处理；这避免 `crypto.verify` 收到 `undefined` 后打断收包并最终触发 keepalive 超时。`disableChatSigning` 不负责入站消息校验，它只控制客户端自身的签名证书。
- ViaProxy 插件会把失败统一显示为认证取消；具体原因以 MULTIBOT 脱敏日志为准。
- OpenAuth 只完成在线会话认证，不保证服务端强制安全聊天时的签名能力，必须单独验收聊天、命令、传送和资源包流程。
- 一个 ViaProxy 进程只有一个 `target-address`。同一目标下的多个 bot 可共用；不同目标服务器使用独立 ViaProxy 工作目录和 loopback 端口。

#### 3.4.5 启动、验收与停止顺序

1. 启动 ViaProxy，确认 Java 17、插件 `Loaded/Enabled`、`OPENAUTHMOD` 和 loopback 监听均生效。
2. 通过 Minecraft 状态 ping 验证 ViaProxy 能访问目标服；仅 TCP 端口可用不能证明 OpenAuth 全链路正常。
3. 启动一个 canary bot，确认服务器看到的名称和 UUID 正确且连接成功，再启动同服其余 bot，避免同时触发大量 Mojang 会话请求。
4. 验收至少包含：多 bot 并发不串号、命令/聊天/传送、代理停止后 bot 停止且不自动重连、插件缺失/目标服不可用/会话失效时的明确失败。
5. 停止时先停止相关 bot，再停止 ViaProxy；重启时反向执行。

---

## 4. `default.config.json` / `config.json`

这一节是 bot 行为配置，也是你日常最常改的部分。

### 4.1 顶层字段

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `trustedPlayers` | string[] | 内置名单 | 受信任玩家列表，用于私聊控制、TPA 等逻辑 |
| `trustedPlayersMergeParent` | boolean | `false` | 是否把上层 `default.config.json` 里的 `trustedPlayers` 与当前实例的 `trustedPlayers` 合并 |
| `trustedPlayersFile` | string / null | `null` | 额外受信任玩家文件，相对 bot 目录，支持热重载 |
| `autoRestart` | number | `0` | legacy 主动重启周期，单位分钟；`0` 表示关闭 |
| `fish` | boolean | `false` | bot 上线后是否自动开始钓鱼 |

说明：

- `trustedPlayers` 未配置时会落到代码里那份内置名单
- 更建议你在自己的 `config.json` 里显式写，避免依赖代码内置名单
- `trustedPlayersMergeParent` 默认为 `false`；开启后会按“上层名单 + 当前实例名单”合并，且会去重
- 这个开关只影响 `trustedPlayers` 和 `trustedPlayersFile` 是否参与最终名单，不会影响 `teleport.whitelistFile`
- `trustedPlayersFile` 只有在 `trustedPlayersMergeParent` 开启时才会参与有效名单，文件修改后会通过 `fs.watch` 自动刷新
- `trustedPlayersFile` 文件每行一个玩家名；空行和 `#` 开头的行会被忽略

### 4.2 `teleport`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `teleport.mode` | string | `whitelist` | 传送请求处理模式 |
| `teleport.whitelistFile` | string | `whitelist.txt` | 白名单文件，相对 bot 目录 |

`teleport.mode` 支持：

- `whitelist`
  - 读取 `whitelist.txt`
- `all`
  - 接受所有普通传送请求
- `trustedPlayers` / `trusted_players`
  - 只接受 `trustedPlayers` 中玩家的传送请求

补充：

- 当前白名单文件会用 `fs.watch` 监听，修改后自动刷新
- `tpahere` 额外受有效受信任玩家名单和 `lock` 逻辑限制

#### 白名单与受信任玩家完整示范

`default.config.json` 推荐写共享策略：

```json
{
  "trustedPlayersMergeParent": true,
  "trustedPlayers": [
    "example_player",
    "ServerOwner"
  ],
  "trustedPlayersFile": "../trustedPlayers.txt",
  "teleport": {
    "mode": "whitelist",
    "whitelistFile": "../whitelist.txt"
  }
}
```

`whitelist.txt` 控制普通 TPA 自动接受：

```txt
# 普通 tpa 白名单
example_player
example_trusted
playerName
```

`trustedPlayers.txt` 控制私聊命令与 `tpahere`：

```txt
# 私聊控制 / tpahere 受信任玩家
example_player
ServerOwner
```

说明：

- `teleport.mode = "whitelist"` 时，普通 TPA 查 `whitelist.txt`
- `teleport.mode = "trustedPlayers"` 时，普通 TPA 查有效受信任玩家名单
- `teleport.mode = "all"` 时，普通 TPA 全部接受
- `tpahere` 始终要求发送者在有效受信任玩家名单内，并且会受 `lock` 限制
- `whitelist.txt` 和 `trustedPlayersFile` 都支持文件保存后自动刷新

### 4.3 `logging`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `logging.logToFile` | boolean | `true` | 是否写单实例聊天日志 |
| `logging.logFilePath` | string | `./assn_chat.log` | 单实例聊天日志路径，相对 bot 目录 |
| `logging.logPlayerList` | boolean | `true` | 是否写单实例玩家列表日志 |
| `logging.playerListPath` | string | `./assn_playerList.log` | 玩家列表日志路径，相对 bot 目录 |
| `logging.playerListIntervalMinutes` | number | `1` | 玩家列表日志写入周期，分钟 |

说明：

- 这里只控制 **单实例文件日志**
- 服务端聚合日志由 `multibot.config.json -> aggregateLogging` 控制

### 4.4 `behavior`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `behavior.enableSpawnActions` | boolean | `false` | 兼容保留字段，当前未迁移 |
| `behavior.whitelistReloadMinutes` | number | `30` | 兼容保留字段，当前不再驱动定时刷新 |
| `behavior.enableResourcePack` | boolean | `false` | 是否接受服务器资源包 |

说明：

- `enableSpawnActions` 当前建议改用 `ScriptScheduler` 或 `script`
- `whitelistReloadMinutes` 现在仅为兼容保留；白名单刷新已改成 `fs.watch`

### 4.5 `capabilities`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `capabilities.entityHandling` | boolean | `true` | 是否启用实体相关能力 |
| `capabilities.terrainHandling` | boolean | `true` | 是否启用地形/区块相关能力 |

效果简述：

- `entityHandling=false`
  - 禁用 `attack @n`、`interact @n`、`ride`、`fish`、`entity list`
  - 关闭实体相关自动功能
  - 录制器会退化为更轻量模式
- `terrainHandling=false`
  - 禁用 `goto`、`useblock`、`dig`、`vault`、`cplace`
  - 关闭地形相关录制与功能

### 4.6 `display`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `display.consoleUseAnsi` | boolean | `false` | 兼容保留字段，当前基本未实际接线 |

### 4.7 `ScriptScheduler`

#### 总开关

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `ScriptScheduler.Enabled` | boolean | `false` | 是否启用脚本调度器 |
| `ScriptScheduler.TaskList` | array | `[]` | 任务列表 |

#### 每个任务支持的字段

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `Task_Name` | string | `Task N` | 任务名称 |
| `Trigger_On_First_Login` | boolean | `false` | 仅首次登录触发 |
| `Trigger_On_Login` | boolean | `false` | 每次 spawn 后触发 |
| `Trigger_On_Login_Delay_Seconds` | number | `0` | 登录触发延迟，秒 |
| `Trigger_On_Times.Enable` | boolean | `false` | 是否启用固定时间触发 |
| `Trigger_On_Times.Times` | string[] | `[]` | 固定触发时刻，格式 `HH:MM:SS` |
| `Trigger_On_Interval.Enable` | boolean | `false` | 是否启用随机区间触发 |
| `Trigger_On_Interval.MinTime` | number | `1` | 随机区间最小值 |
| `Trigger_On_Interval.MaxTime` | number | `1` | 随机区间最大值 |
| `Trigger_On_Interval.Unit` | string | `seconds` | 单位，支持 `seconds` / `hours` 及其常见别名 |
| `Action` | string | `""` | 要执行的命令字符串 |

说明：

- `Action` 走的是正常命令分发器
- 所以脚本任务同样受白名单、锁、能力开关等限制

#### `ScriptScheduler` 完整示范

下面示例覆盖当前所有可配置字段：

```json
{
  "ScriptScheduler": {
    "Enabled": true,
    "TaskList": [
      {
        "Task_Name": "First Login Init",
        "Trigger_On_First_Login": true,
        "Trigger_On_Login": false,
        "Trigger_On_Login_Delay_Seconds": 5,
        "Trigger_On_Times": {
          "Enable": false,
          "Times": []
        },
        "Trigger_On_Interval": {
          "Enable": false,
          "MinTime": 1,
          "MaxTime": 1,
          "Unit": "seconds"
        },
        "Action": "send 首次登录初始化完成"
      },
      {
        "Task_Name": "Every Login Status",
        "Trigger_On_First_Login": false,
        "Trigger_On_Login": true,
        "Trigger_On_Login_Delay_Seconds": 15,
        "Trigger_On_Times": {
          "Enable": false,
          "Times": []
        },
        "Trigger_On_Interval": {
          "Enable": false,
          "MinTime": 1,
          "MaxTime": 1,
          "Unit": "seconds"
        },
        "Action": "health"
      },
      {
        "Task_Name": "Daily Fixed Times",
        "Trigger_On_First_Login": false,
        "Trigger_On_Login": false,
        "Trigger_On_Login_Delay_Seconds": 0,
        "Trigger_On_Times": {
          "Enable": true,
          "Times": [
            "00:00:00",
            "12:00:00",
            "18:30:00"
          ]
        },
        "Trigger_On_Interval": {
          "Enable": false,
          "MinTime": 1,
          "MaxTime": 1,
          "Unit": "seconds"
        },
        "Action": "send 定时整点任务"
      },
      {
        "Task_Name": "Random Interval Seconds",
        "Trigger_On_First_Login": false,
        "Trigger_On_Login": false,
        "Trigger_On_Login_Delay_Seconds": 0,
        "Trigger_On_Times": {
          "Enable": false,
          "Times": []
        },
        "Trigger_On_Interval": {
          "Enable": true,
          "MinTime": 30,
          "MaxTime": 90,
          "Unit": "seconds"
        },
        "Action": "send 秒级随机间隔任务"
      },
      {
        "Task_Name": "Random Interval Hours",
        "Trigger_On_First_Login": false,
        "Trigger_On_Login": false,
        "Trigger_On_Login_Delay_Seconds": 0,
        "Trigger_On_Times": {
          "Enable": false,
          "Times": []
        },
        "Trigger_On_Interval": {
          "Enable": true,
          "MinTime": 1,
          "MaxTime": 3,
          "Unit": "hours"
        },
        "Action": "script daily-maintenance.txt"
      }
    ]
  }
}
```

字段行为：

- `Enabled=false` 时整个调度器不启动
- `Task_Name` 为空时会归一化为 `Task N`
- `Trigger_On_First_Login=true`：当前 runtime 第一次 spawn 后触发一次
- `Trigger_On_Login=true`：每次 spawn 后都会触发
- `Trigger_On_Login_Delay_Seconds`：登录触发延迟，允许 `0`
- `Trigger_On_Times.Enable=true`：启用每日固定时间触发
- `Trigger_On_Times.Times`：只接受合法 `HH:MM:SS`，会去重并归一化为两位格式
- `Trigger_On_Interval.Enable=true`：启用随机间隔循环触发
- `Trigger_On_Interval.MinTime` / `MaxTime`：如果写反，会自动按较小值/较大值归一化
- `Trigger_On_Interval.Unit`：支持 `seconds` / `second` / `sec` / `secs` / `s` 和 `hours` / `hour` / `hr` / `hrs` / `h`
- `Action`：执行普通 MULTIBOT 命令，也可以是 `script <文件>` 调用脚本文件

### 4.8 `attack`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `attack.autoAttack` | boolean | `false` | 是否自动攻击附近目标 |
| `attack.attackRange` | number | `3` | 攻击半径 |
| `attack.attackInterval` | integer | `2000` | 自动攻击轮询间隔，毫秒 |
| `attack.targetFilter.excludePlayers` | boolean | `false` | 是否排除玩家 |
| `attack.targetFilter.excludeItems` | boolean | `true` | 是否排除掉落物与经验球 |
| `attack.targetFilter.targetTypes` | string[] | `[]` | 目标类型白名单 |

`targetTypes` 匹配规则：

- 可以写通用类型：`mob` / `player` / `object` / `item` / `orb`
- 也可以写实体 `name` / `displayName` / `type`
- 比较时统一转小写

### 4.9 `blockBreakDetection`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `blockBreakDetection.enabled` | boolean | `false` | 是否启用方块破坏监控 |
| `blockBreakDetection.alertTrustedPlayers` | string[] | `[]` | 发现事件后私聊提醒这些玩家 |
| `blockBreakDetection.excludeCreativeMode` | boolean | `true` | 是否忽略创造模式玩家造成的破坏 |
| `blockBreakDetection.logToConsole` | boolean | `true` | 是否打印到实例控制台 |
| `blockBreakDetection.logToFile` | boolean | `false` | 是否写文件 |
| `blockBreakDetection.logFilePath` | string | `./block-break.log` | 日志路径，相对 bot 目录 |
| `blockBreakDetection.monitoredBlocks` | string[] | `[]` | 监控的方块名列表；空数组表示不过滤 |

说明：

- `monitoredBlocks` 里写的是 `block.name`
- 空数组表示“所有匹配事件都监控”

### 4.10 `monitoring`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `monitoring.enabled` | boolean | `false` | 是否启用实体监控 |
| `monitoring.intervalSeconds` | number | `10` | 扫描间隔，秒 |
| `monitoring.targetTypes` | string[] | `["minecraft:wandering_trader", "minecraft:trader_llama"]` | 监控目标类型 |

说明：

- 类型会统一规范化，小写并去掉 `minecraft:` 前缀再比较
- 如果 `targetTypes` 为空，则默认只监控 `mob`
- 结果会去重并记录到 bot 目录下固定的 `found.txt`

### 4.11 `recording`

这是当前字段最多的一块。

#### 基础控制

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `recording.enabled` | boolean | `false` | 是否启用本地可选录制器；公开仓库不包含其实现，缺少模块时状态为 `unavailable` 且不影响 Bot 启动 |
| `recording.outputDir` | string | `MULTIBOT/replays` | 输出目录；相对路径按 bot 目录解析 |
| `recording.bootstrapWindowTicks` | integer | `20` | 登录后 bootstrap 物理帧窗口 |
| `recording.bootstrapTimeoutMs` | integer | `5000` | bootstrap 超时，毫秒 |

说明：

- 如果没写 `outputDir`，当前默认输出到 `MULTIBOT/replays`
- 如果显式写了相对路径，则按 bot 目录解析

#### 世界 / 实体采集项

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `recording.includeWorldSnapshot` | boolean | `true` | 是否保存初始世界快照 |
| `recording.includeMinimalLocalPlayer` | boolean | `true` | 是否至少保留本体最小状态 |
| `recording.entityScope` | string | `all_visible` | 实体记录范围 |
| `recording.equipmentScope` | string | `all_with_equipment` | 装备记录范围，当前保持透传 |
| `recording.includeTimeUpdates` | boolean | `true` | 是否记录时间变化 |
| `recording.includeWeatherState` | boolean | `true` | 是否记录天气状态 |
| `recording.includeDifficulty` | boolean | `true` | 是否记录难度 |
| `recording.includeSpawnPosition` | boolean | `true` | 是否记录出生点 |
| `recording.includeWorldBorder` | boolean | `true` | 是否记录世界边界 |
| `recording.includeBlockEntityUpdates` | boolean | `true` | 是否记录方块实体更新 |
| `recording.includeLaterChunkLoads` | boolean | `true` | 是否记录后续区块加载 |
| `recording.includeParticles` | boolean | `true` | 是否记录粒子 |
| `recording.includeCollectAnimation` | boolean | `true` | 是否记录收集动画 |
| `recording.includeHurtAnimation` | boolean | `true` | 是否记录受伤动画 |
| `recording.includeBossBar` | boolean | `true` | 是否记录 BossBar |
| `recording.includeScoreboard` | boolean | `true` | 是否记录计分板 |
| `recording.includeTabListHeaderFooter` | boolean | `true` | 是否记录 Tab 页头尾 |
| `recording.includeMapData` | boolean | `true` | 是否记录地图数据 |

关于 `entityScope`：

- 默认是 `all_visible`
- 当前代码额外支持内部轻量模式 `self_only`
- `entityHandling=false` 时会被系统强制改成 `self_only`

#### 分片 / 导出 / 缓存

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `recording.chunkDurationTicks` | integer | `6000` | 录制分片 tick 长度 |
| `recording.archiveRotationEnabled` | boolean | `true` | 是否启用归档轮转 |
| `recording.archiveNominalMinutes` | number | `60` | 单段录制名义时长，分钟 |
| `recording.archiveOverlapMinutes` | number | `5` | 相邻录制段重叠时间，分钟 |
| `recording.recoverPendingArchivesOnStart` | boolean | `true` | 启动时是否恢复未完成归档 |
| `recording.shutdownExportTimeoutMs` | integer | `60000` | 停机导出超时，毫秒 |
| `recording.enableChunkCache` | boolean | `true` | 是否启用区块缓存 |
| `recording.continueAcrossDimensions` | boolean | `true` | 是否跨维度继续录制 |

#### 调试 / 高级项

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `recording.debug` | boolean | `false` | 是否启用 recorder 调试模式 |
| `recording.debugChunkCapture` | boolean | `false` | 是否调试区块抓取 |
| `recording.debugChunkCaptureLimit` | integer | `20` | 调试区块抓取数量上限 |
| `recording.debugDroppedPackets` | boolean | `false` | 是否调试被过滤掉的数据包 |
| `recording.memoryMonitor` | object | 无 | 高级透传字段，暂无稳定外部文档，一般不需要手配 |

#### 兼容保留但当前未完全接线的字段

| 字段 | 当前状态 |
| --- | --- |
| `recording.debugLogFileEnabled` | 已出现在 legacy 默认配置里，但当前 `RecorderFeature` 未透传 |
| `recording.debugLogFilePath` | 已出现在 legacy 默认配置里，但当前 `RecorderFeature` 未透传 |

`RecorderFeature` 是本地可选模块的适配层。公开仓库不包含 `flashback-recorder` 实现，也不代表与 Flashback 官方项目或其作者存在关联；没有本地模块时，录制相关命令仍可查询状态或安全结束空实现，其余 Bot 功能保持可用。

### 4.12 能力开关与录制器联动

如果：

- `capabilities.entityHandling = false`

则录制器会自动收缩为更轻量模式，例如：

- `entityScope` 强制为 `self_only`
- 关闭 `includeCollectAnimation`
- 关闭 `includeHurtAnimation`

如果：

- `capabilities.terrainHandling = false`

则录制器会自动关闭一部分地形相关项，例如：

- `includeWorldSnapshot`
- `includeLaterChunkLoads`
- `includeBlockEntityUpdates`
- `enableChunkCache`

也就是说，`recording` 里某些字段即使你手动写了，在能力开关关闭时也可能被运行时下调。

---

## 5. 推荐写法

### 5.1 `multibot.config.json`

```json
{
  "api": {
    "host": "127.0.0.1",
    "port": 18080,
    "token": "change-me"
  },
  "consoleConnector": {
    "historyLimit": 300
  },
  "defaults": {
    "auth": "microsoft",
    "version": "1.21.11",
    "viewDistance": "tiny",
    "disableChatSigning": true,
    "restartOnDisconnect": true,
    "restartDelayMs": 60000,
    "restartJitterMs": 120000
  },
  "discovery": {
    "enabled": true,
    "botsRoot": "./BOTS"
  }
}
```

### 5.2 `server.json`

```json
{
  "host": "viaproxy.local",
  "port": 25568,
  "version": "1.21.11",
  "auth": "microsoft",
  "openAuth": {
    "enabled": true,
    "requestTimeoutMs": 4500
  },
  "restartOnDisconnect": true,
  "restartDelayMs": 60000,
  "restartJitterMs": 120000
}
```

这个示例假设 ViaProxy 已在本机 `127.0.0.1:25568` 运行；实际目标服务器地址写在 ViaProxy 的 `target-address`，不要把公网目标地址填回这里。直连服务器的写法见上面的 3.3 节。

### 5.3 `default.config.json`

推荐把同服共享的白名单、受信任玩家、能力开关、录制默认值写在这里。这样新建 bot 时可以继承，单 bot 需要特殊行为时再在自己的 `config.json` 里覆盖。

```json
{
  "trustedPlayers": [
    "example_player",
    "ServerOwner"
  ],
  "trustedPlayersFile": "../trustedPlayers.txt",
  "teleport": {
    "mode": "whitelist",
    "whitelistFile": "../whitelist.txt"
  },
  "logging": {
    "logToFile": false,
    "logPlayerList": false
  },
  "capabilities": {
    "entityHandling": true,
    "terrainHandling": true
  },
  "recording": {
    "enabled": false
  }
}
```

配套 `whitelist.txt` 示例：

```txt
# 普通 tpa 白名单，每行一个玩家名
example_player
example_trusted
playerName
```

配套 `trustedPlayers.txt` 示例：

```txt
# 私聊控制 / tpahere 受信任玩家，每行一个玩家名
example_player
ServerOwner
```

推荐关系：

- `teleport.mode = "whitelist"`：普通 TPA 自动接受只查 `whitelist.txt`
- `teleport.mode = "trustedPlayers"`：普通 TPA 自动接受查有效受信任玩家名单
- `trustedPlayers`：直接写在 JSON 里的受信任玩家
- `trustedPlayersFile`：额外受信任玩家文件，保存后会热重载
- `teleport.whitelistFile`：普通 TPA 白名单文件，保存后会热重载
- `tpahere`：始终要求发送者属于有效受信任玩家，并且受 `lock` 限制

### 5.4 单 bot `config.json`

推荐只在单 bot 里写账号、单实例开关、录制路径，以及确实需要覆盖共享默认值的内容。

```json
{
  "id": "example_bot",
  "enabled": true,
  "autoStart": false,
  "email": "example@outlook.com",
  "username": "example_bot",
  "trustedPlayers": [
    "example_player",
    "BotAdminForThisInstance"
  ],
  "trustedPlayersFile": "../trustedPlayers.txt",
  "teleport": {
    "mode": "whitelist",
    "whitelistFile": "../whitelist.txt"
  },
  "recording": {
    "enabled": true,
    "outputDir": "../replays"
  },
  "ScriptScheduler": {
    "Enabled": true,
    "TaskList": [
      {
        "Task_Name": "First Login Init",
        "Trigger_On_First_Login": true,
        "Trigger_On_Login": false,
        "Trigger_On_Login_Delay_Seconds": 5,
        "Trigger_On_Times": {
          "Enable": false,
          "Times": []
        },
        "Trigger_On_Interval": {
          "Enable": false,
          "MinTime": 1,
          "MaxTime": 1,
          "Unit": "seconds"
        },
        "Action": "send 首次登录初始化完成"
      },
      {
        "Task_Name": "Every Login Status",
        "Trigger_On_First_Login": false,
        "Trigger_On_Login": true,
        "Trigger_On_Login_Delay_Seconds": 15,
        "Trigger_On_Times": {
          "Enable": false,
          "Times": []
        },
        "Trigger_On_Interval": {
          "Enable": false,
          "MinTime": 1,
          "MaxTime": 1,
          "Unit": "seconds"
        },
        "Action": "health"
      },
      {
        "Task_Name": "Daily Fixed Times",
        "Trigger_On_First_Login": false,
        "Trigger_On_Login": false,
        "Trigger_On_Login_Delay_Seconds": 0,
        "Trigger_On_Times": {
          "Enable": true,
          "Times": [
            "00:00:00",
            "12:00:00",
            "18:30:00"
          ]
        },
        "Trigger_On_Interval": {
          "Enable": false,
          "MinTime": 1,
          "MaxTime": 1,
          "Unit": "seconds"
        },
        "Action": "send 定时整点任务"
      },
      {
        "Task_Name": "Random Interval Seconds",
        "Trigger_On_First_Login": false,
        "Trigger_On_Login": false,
        "Trigger_On_Login_Delay_Seconds": 0,
        "Trigger_On_Times": {
          "Enable": false,
          "Times": []
        },
        "Trigger_On_Interval": {
          "Enable": true,
          "MinTime": 30,
          "MaxTime": 90,
          "Unit": "seconds"
        },
        "Action": "send 秒级随机间隔任务"
      },
      {
        "Task_Name": "Random Interval Hours",
        "Trigger_On_First_Login": false,
        "Trigger_On_Login": false,
        "Trigger_On_Login_Delay_Seconds": 0,
        "Trigger_On_Times": {
          "Enable": false,
          "Times": []
        },
        "Trigger_On_Interval": {
          "Enable": true,
          "MinTime": 1,
          "MaxTime": 3,
          "Unit": "hours"
        },
        "Action": "script daily-maintenance.txt"
      }
    ]
  }
}
```

`ScriptScheduler` 推荐写法说明：

- 每个任务都建议完整写出所有触发字段，避免以后回头看不清楚任务靠什么触发
- `Trigger_On_First_Login=true`：当前 runtime 第一次 spawn 后触发一次
- `Trigger_On_Login=true`：每次 spawn 后都会触发，可配 `Trigger_On_Login_Delay_Seconds`
- `Trigger_On_Times.Enable=true`：按每日固定时间触发，`Times` 使用 `HH:MM:SS`
- `Trigger_On_Interval.Enable=true`：按随机间隔循环触发
- `Trigger_On_Interval.Unit` 推荐写标准值 `seconds` 或 `hours`
- `Action` 执行普通 MULTIBOT 命令，也可以写 `script <文件>` 调用脚本文件

---

## 6. 常见建议

- **想改 API / 日志 / 全局发现策略**
  - 改 `multibot.config.json`
- **想改同服共享连接参数**
  - 改 `server.json`
- **想给同服所有 bot 设共同的录制 / 白名单 / 能力开关默认值**
  - 改 `default.config.json`
- **想改单个 bot 的账号、脚本、录制或白名单行为**
  - 改该 bot 自己的 `config.json`

### 6.1 关于重连

当前推荐默认值已经改为：

- `restartDelayMs = 60000`
- `restartJitterMs = 120000`

也就是把同波断线的 bot 重连时间打散到 `60 ~ 180 秒`。

如果想让重连延迟随失败次数逐步拉长，可以在 `server.json` 顶层配置 `restartDelayScheduleMs`（分级数组）和 `restartDelayScheduleRepeatLast`（耗尽后重复最后一级或停止），见 3.1 节。

如果服务端偶发卡顿导致本地 keepalive 超时，可在 `server.json` 或 `connection` 中设置：

- `checkTimeoutInterval = 120000`

### 6.2 关于 legacy 兼容字段

以下字段目前更偏“兼容保留”，不要指望它们驱动旧版全部行为：

- `behavior.enableSpawnActions`
- `behavior.whitelistReloadMinutes`
- `display.consoleUseAnsi`
- `recording.debugLogFileEnabled`
- `recording.debugLogFilePath`

### 6.3 关于生效时机

- 修改 `config.json` / `default.config.json` 后，通常应走实例同步路径，或重启整个 `MULTIBOT`
- 单纯某些旧语义下的普通 `restart`，不一定代表“重新从磁盘全量扫描所有配置”

### 6.4 关于单实例瘦终端连接器

- 如果你想把旧单实例面板进程改成“远程控制台”，看的是：
  - `multibot.config.json -> consoleConnector.historyLimit`
- 这个配置决定的是：
  - 单实例连接器首次接入某个 bot 时，后端最多回放多少条历史日志
- 当前默认值：
  - `historyLimit = 300`
- 连接器启动方式固定是：
  - `node .\console-connector.js --bot-id <id> --api-base <url> --token <token>`
- 当前不支持：
  - 环境变量注入 `apiBase`
  - 环境变量注入 `token`
  - 本地连接器配置文件
- 连接器离线时输入 `/start`：
  - 会先立即尝试重连后端
  - 重连成功后再调用后端 `start`
  - 若仍连不上，则直接提示失败，不缓存命令
## 7. 完整示范配置目录

`MULTIBOT/examples/full-config-example/` 提供了一套可直接对照的完整示范：

- `multibot.config.json`：后端全局配置
- `server.json`：同服共享连接与运行时覆盖
- `default.config.json`：同服共享 bot 默认值
- `config.json`：单个实例自己的配置
- `../trustedPlayers.txt`：供 `trustedPlayersFile` 使用的共享名单
- `../whitelist.txt`：供 `teleport.whitelistFile` 使用的共享白名单

这套示范里已经把下面几类常用项串起来了：

- `protocolGuard.logParseErrors`
- `trustedPlayersMergeParent`
- `trustedPlayersFile`
- `teleport.whitelistFile`
- `capabilities.entityHandling`
- `capabilities.terrainHandling`
- `recording.enabled`
- `ScriptScheduler`
