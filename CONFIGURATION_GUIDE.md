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
| `protocolGuard.desyncSilenceMs` | integer | `8000` | 被协议保护吞掉解析异常后，多少毫秒内收不到任何包就判定会话失联并主动断开重连；`0` 关闭该看门狗（退回等保活超时） |

说明：

- 这是 `mineflayer` 协议层热修复相关配置
- 当前仓库模板里通常会把 `logParseErrors` 关掉来降低噪声，但代码默认仍是 `true`

### 2.3 `diagnostics`

#### `diagnostics.cpuProfileOnExit`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `diagnostics.cpuProfileOnExit` | boolean | `false` | 是否在控制台输入 `exit` 时保留 CPU profile 写入等待；启动脚本仅在开启时传递 Node CPU profiling 参数 |

说明：

- `false` 时输入 `exit` 会在正常停止后立即退出，不生成 `.cpuprofile`。
- `true` 时必须使用 `start-multibot.ps1` 启动，脚本会启用 `--cpu-prof` 并将 profile 写入 `profiles/cpu`。
- 直接执行 `node index.js` 不会根据配置自动添加 Node profiling 参数。

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

### 2.9 `notifications`

这个配置块写在 `multibot.config.json` 顶层，用来开关“关键事件推送到手机（Bark）”。默认**关闭**，不配置就完全不推送。

```json
{
  "notifications": {
    "bark": {
      "enabled": false,
      "scriptPath": "./src/notifications/bark/bark-push.ps1",
      "envPath": "./.env",
      "group": "mc",
      "logPath": "./logs/bark.log",
      "cooldownMs": 600000,
      "timeoutMs": 25000,
      "retryOnce": true
    },
    "events": {
      "enabled": true,
      "maxPerHour": 6,
      "maxEventStates": 2000,
      "checkIntervalMs": 60000
    }
  }
}
```

#### 2.9.1 `bark`：推送通道

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `bark.enabled` | boolean | `false` | 总开关，必须显式设为 `true` 才会推送 |
| `bark.scriptPath` | string | `./src/notifications/bark/bark-push.ps1` | 推送脚本，相对路径按项目根解析 |
| `bark.envPath` | string | `./.env` | 存放 Bark 地址/凭据/加密密钥的 env 文件；**凭据只由脚本读取，后端进程不解析、不记录** |
| `bark.group` | string | `mc` | Bark 通知分组名 |
| `bark.logPath` | string | `./logs/bark.log` | 每次推送尝试的结果流水（成功/失败/被抑制） |
| `bark.cooldownMs` | integer | `600000` | 403 自愈专用推送的同 bot 冷却 |
| `bark.timeoutMs` | integer | `25000` | 外层等待脚本结束的超时，超时按 `wrapper-timeout` 记失败 |
| `bark.retryOnce` | boolean | `false` | 首次失败后等待 2 秒重发一次（共 2 次尝试） |

说明：

- `.env` 里需要的键由 `bark-push.ps1` 头部注释说明（地址、Basic 认证、device key、可选 AES 密钥）
- `.ps1` 必须是 **UTF-8 with BOM**，Windows PowerShell 5.1 才能正确解析其中的中文
- 推送内容不含任何凭据；失败只记录**脱敏分类**（`timeout` / `dns-fail` / `tls-fail` / `http-4xx` / `env-missing` …）

#### 2.9.2 `events`：事件告警

`events.enabled` 是事件层总开关（缺省开）。`maxPerHour` 限制每小时真正发出的条数，超出部分会被折叠计数，并在下一次实际推送的正文里带上“折叠 N 次”。`maxEventStates` 是去重状态表的容量上限（防止高基数事件把内存撑大），`checkIntervalMs` 是巡检器（服务器全员离线 / bot 卡死 / 日志过大）的检查周期，最小 `10000`。

每个事件都可以单独开关并覆盖阈值：

```json
{
  "notifications": {
    "events": {
      "enabled": true,
      "maxPerHour": 6,
      "maxEventStates": 2000,
      "checkIntervalMs": 60000,
      "botStuck": { "enabled": true, "stuckMs": 1800000, "cooldownMs": 1800000 },
      "deviceCode": { "enabled": false }
    }
  }
}
```

| 事件键 | 触发条件 | 级别 | 默认阈值 |
| --- | --- | --- | --- |
| `uncaughtException` | 进程内未捕获异常（未退出）累计 | active | `threshold` 3 次 / `windowMs` 1 小时 |
| `deviceCode` | 需要设备码人工登录（Microsoft） | critical | 冷却 10 分钟 |
| `openAuthPermanentFailure` | OpenAuth 永久失败并停止重连 | critical | 冷却 10 分钟 |
| `refreshTokenInvalid` | refresh token 失效（`invalid_grant` / AADSTS / 明确的过期、吊销文案） | critical | 冷却 10 分钟 |
| `invalidSession` | 会话失效计数（跨“失效→重启→上线”循环累计，不因中间上线而清零） | critical | `threshold` 3 次 / `windowMs` 1 小时 |
| `authRejected` | 账号被认证服务拒绝/封禁 | critical | 冷却 10 分钟 |
| `serverAllOffline` | 同一 `host:port` 下期望运行的 bot 全部离线 | critical | 持续 `offlineMs` 2 分钟；`minBots` 2 |
| `restartExhausted` | 自动重连次数用尽，已停止重连 | critical | 冷却 10 分钟 |
| `botStuck` | 期望运行但非在线，且超过阈值没有进展（判定基准取“最近一次活动”与“本次启动起点”中较晚者，且期间没有待执行的重连；手动停止很久后重新启动不会被误判） | critical | `stuckMs` 30 分钟 |
| `logFileTooLarge` | `logs/` 下单文件超过阈值 | active | `maxBytes` 1GB；每 `checkIntervalMs` 1 小时扫一次 |
| `apiAuthFailure` | 同一来源的 API 认证失败次数 | critical | `threshold` 10 次 / `windowMs` 10 分钟 |
| `pushFailing` | 推送自身连续失败 | active | `threshold` 3 次 |

说明：

- `critical` 对应 Bark 的 `timeSensitive`（可突破专注模式），`active` 对应普通提醒，恢复通知按 `active` 发送
- 冷却以“上次尝试”计时（而不是上次成功），避免推送持续失败时被反复重试刷屏
- 恢复通知是**配对**的：只有同一类问题真的推送过，恢复时才补一条（带持续时长），不会凭空发“已恢复”
- 恢复只清掉“这一轮故障”的痕迹，**保留冷却时钟**：所以“刚恢复又立刻失效”不会马上再推一条 critical，而是被冷却折叠进下一次
- 被冷却/限流压掉的次数会累计；`logs/bark.log` 的 `[SKIP]` 行有双重下限（每轮第一条一定写，之后要求时间≥60 秒且次数为 10 的整数倍），长时间故障或高频请求都不会把日志刷大
- 阈值判定占用内存与请求量无关（计数器只保留首个时间戳与计数），公网端口被刷认证失败也不会把内存顶起来

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

#### 私聊格式匹配

不同服务端/插件会改写私聊行的格式（例如 `[playerName → 我] 内容`）。可在 `server.json` 的 `whisperMatchers.incoming` 中追加匹配规则，写法和约束与 `teleportPromptMatchers` 一致：

```json
{
  "whisperMatchers": {
    "incoming": [
      "^\\[(?<sender>[A-Za-z0-9_]{1,16}) → 我\\]\\s*(?<content>.*)$"
    ]
  }
}
```

- 内置的原版形态（`<名字> whispers to you: 内容` 与 `%s whispers to you: %s`）**始终生效**，自定义规则只在它们不匹配时启用。
- 每条规则必须 `^` 开头、`$` 结尾，必须包含命名捕获组 `(?<sender>...)` 与 `(?<content>...)`；每组最多 20 条、每条最多 500 字符，非法正则会阻止配置加载并指出具体位置。
- **务必保持整行锚定，并把接收者等固定文字写进规则**：消息在匹配前会剥离 `§` 颜色码，但公屏内容的前缀（如 `[生存]  playerName » `）不会被剥离；一旦规则放宽，公屏上伪造一条结构相同的消息就会让 bot 当成私聊处理。
- 即使某行被判定为私聊，也只有 `trustedPlayers` 名单内的玩家才会被当作命令执行。
- 该配置只允许放在 `server.json`，不从 `default.config.json` 或单 bot `config.json` 读取。

bot 回复私聊默认使用 `/minecraft:w`（成功回复）与 `/tell`（错误回复）。若服务端改掉了这两个命令，可在 `server.json` 中用 `whisperCommands` 覆盖（必须是单个以 `/` 开头的命令 token）：

```json
{
  "whisperCommands": {
    "reply": "/minecraft:w",
    "error": "/tell"
  }
}
```

例如 `Somebody: Player 请求传送到你的位置`、`[聊天] Player 想要传送到你这里` 都不会命中内置规则，因为消息开头包含额外内容。

### 3.4 ViaProxy/OpenAuth（26.1.2）

当目标服务器强制使用 `26.1.2`，而当前 Mineflayer 客户端协议为 `1.21.11` 时，可用 ViaProxy 做协议转换，并由 MULTIBOT 的 OpenAuth 客户端使用各 bot 自己的 Microsoft 会话完成目标服认证：

升级后请重启进程以加载新代码，可通过启动首行打印的 `MULTIBOT <版本号>` 确认运行的是新进程（版本号以启动输出为准，不在此文档维护）。

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
| `behavior.physicsStandby` | boolean | `false` | 挂机省电：空闲时关闭 mineflayer 物理模拟（`bot.physicsEnabled=false`），移动/骑乘/蹲下时自动恢复 |
| `behavior.lockAfterExpireCommand` | string | `/home` | 锁**自然到期**后自动执行的命令（游戏内命令需带 `/`；空字符串 `""` = 禁用）。手动 `unlock` 不触发；到期时 bot 不在线则记为待执行，恢复上线后补执行一次 |

说明：

- `enableSpawnActions` 当前建议改用 `ScriptScheduler` 或 `script`
- `whitelistReloadMinutes` 现在仅为兼容保留；白名单刷新已改成 `fs.watch`
- `lockAfterExpireCommand` 的优先级：单只 bot 的 `config.json` > 所在服务器的 `default.config.json` > 代码默认 `/home`；此外**单次锁定**可用 `lock <1s|1m|1h|1d> <原因> [true|false]` 的尾参覆盖（`true` = 到期执行，且全局配置为空时回退 `/home`；`false` = 本次不执行；不写 = 跟随全局配置）

### 4.5 `capabilities`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `capabilities.entityHandling` | boolean | `true` | 是否启用实体相关能力 |
| `capabilities.terrainHandling` | boolean | `true` | 是否启用地形/区块相关能力 |
| `capabilities.inventoryHandling` | boolean | `true` | 是否启用背包相关能力（轻量模式下控制是否装载零实体背包核心） |

效果简述：

- `entityHandling=false`
  - 禁用 `attack @n`、`interact @n`、`ride`、`fish`、`entity list`
  - 关闭实体相关自动功能
  - 录制器会退化为更轻量模式
- `terrainHandling=false`
  - 禁用 `goto`、`useblock`、`dig`、`vault`、`cplace`
  - 关闭地形相关录制与功能

轻量模式（`entityHandling=false` 且 `terrainHandling=false`）：

- 不再加载处理区块/实体/物理的插件，避免跨版本挂机时的解析与内存开销
- **仍然可用**：自身背包（`inv` 系列命令）、**服务器主动打开的窗口／自定义菜单**（面板可查看、`chest info|click|swap|drag|move|close`、面板"关闭窗口"与点击接口）、**进食与自动进食**（`eat <物品id>`、`autoeat on|off|status`，见 4.9；需要 `capabilities.inventoryHandling !== false`），以及聊天、脚本调度等
- **不可用**：走位（`goto` 等）、对着方块开箱子、实体交互（这些需要地形或实体数据）
- 服务器菜单的窗口标题会随快照一起返回；未识别的自定义菜单类型按容器槽位数展示

### 4.5.1 窗口点击（原版语义）

`chest` 命令与 `POST /api/bots/:id/window-click` 提供与游戏内鼠标操作一致的单次点击。
槽位为窗口原始索引（`chest info` 可列出），`-999` 表示窗口外（丢弃光标上的物品）。

| 操作 | 命令 | 原版对应 |
| --- | --- | --- |
| 左键 | `chest click <槽位>` | 拿起/放下整组 |
| 右键 | `chest click <槽位> right` | 拿起一半/放下一个 |
| Shift 点击 | `chest click <槽位> shift` | 快速移动 |
| Shift+右键 | `chest click <槽位> shift-right` | 快速移动到快捷栏 |
| 与快捷栏交换 | `chest swap <槽位> 1-9` | 数字键 |
| 与副手交换 | `chest swap <槽位> offhand` | F 键 |
| 丢一个 / 丢一组 | `chest click <槽位> drop｜dropstack` | Q / Ctrl+Q |
| 双击收集 | `chest click <槽位> collect` | 双击同类物品 |
| 创造模式复制 | `chest click <槽位> clone` | 中键 |
| 拖拽分发 | `chest drag start｜add <槽位>｜end [left｜right｜middle]` | 按住鼠标划过多个槽位 |

说明：

- 点击遵循原版协议：`windowId` + 该窗口**最新 stateId**（1.17.1+）+ `slot/mouseButton/mode`
- **本地预测只用于即时反馈，不随包上传**：1.21.11 的 `changedSlots`/`cursorItem` 是 `HashedStack`（组件需 CRC32C 哈希），
  而 JS 栈里 `Item.toNotch()` 产出的是 `UntrustedSlot` 形状；组件非空时哈希必然错误。服务端只把它当"远端预期"、
  **从不校验**，因此这里发空 `changedSlots` 并省略 `cursorItem`，服务器总会回发真实槽位（代价是每次点击多几个纠正包，
  换来的是绝不出现状态漂移）
- 窗口内容（stateId）到达前**拒绝点击**并提示"窗口尚未同步"，避免发 `stateId=-1` 的包触发全量重同步
- 光标物品：处理服务器的 `set_cursor_item`（上游 mineflayer 至今未处理），随快照返回 `cursor` 字段
- 窗口标题 `title`：服务器给自定义名称（`{text:...}`）时直接用自定义名称；只有翻译键时**直接用键名**
  （如 `container.chest`），不做译名查表；`extra`/`with` 追加在后面
- 副手槽（快捷栏 F 的目标）**不在容器菜单的同步范围内**（只属于玩家背包菜单）：在箱子/菜单里做副手交换，
  服务端会执行，但本地要等关闭窗口后才看得到副手的新内容
- 窗口外点击（`-999`）：空手时按原版发 `THROW`（服务端无操作），手持物品时才是 `PICKUP`（丢弃光标物品）
- 两条原版硬性规则（违反时服务端静默不处理）：
  - `drop` / `dropstack`（Q / Ctrl+Q）要求**光标为空**（服务端条件 `getCarried().isEmpty()`）
  - `collect`（双击收集）要求**被点的那一格为空**：先拿起一格，再对已空的那格双击
    （服务端条件 `!carried.isEmpty() && (!slot.hasItem() || !slot.mayPickup(player))`）
- 拖拽：强制 `start → add → end` 顺序并按槽位去重（原版同槽只算一次）；原版在鼠标释放时一次性发包，
  此处按调用即时发包，服务端处理结果一致
- 副手交换（button 40）与拖拽起始不做本地预测，直接按原版发包、等服务器回包纠正
- **"点一下就触发动作"的菜单请用 `chest click`**：`chest move` 是交换式操作（会点两次甚至三次），
  在菜单上可能重复触发动作
- 面板接口：`POST /api/bots/:id/window-click`,body 为 `{ slot, action }`（action 同上表），
  或原版三元组 `{ slot, button, mode }`；返回 `{ ok, click: { windowId, slot, mouseButton, mode, stateId, predicted, skipped, changedSlots } }`
- 尚未支持：附魔台/织布机/讲台/切石机的**菜单按钮**（原版走 `container_button_click` 包，另一个包；
  当前 minecraft-data 1.21.11 未定义该包，接入需要自定义包定义）

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

### 4.9 `autoEat`

自动进食：饱食度不足时自动吃背包里的食物。**轻量模式同样可用**（不依赖实体/地形，但要求 `capabilities.inventoryHandling !== false`）。

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `autoEat.enabled` | boolean | `false` | 是否启用自动进食 |
| `autoEat.threshold` | integer | `19` | 饱食度 **≤** 该值时进食，范围 0–20 |
| `autoEat.items` | string[] | `[]` | 按此顺序优先尝试；支持 `minecraft:` 前缀（会归一化）；留空表示"按食物点数/饱和度自动择优" |
| `autoEat.cooldownMs` | integer | `3000` | 成功进食后的冷却，毫秒（0–600000） |
| `autoEat.failureBackoffMs` | integer | `30000` | 连续失败达上限后的暂停时长，毫秒（0–3600000） |
| `autoEat.maxFailures` | integer | `3` | 连续失败多少次后进入退避（1–100） |

写法与行为：

- 可以只写 `"autoEat": true`（用全部默认值开启），或 `"autoEat": false` / 不写（关闭）
- 配置层级遵循 1.4 的优先级：**代码内建默认 → `default.config.json` → `config.json`**（不读取 `server.json` 与 `multibot.config.json`）
- `items` 里**显式写出**的物品即使不在食物表里也会被尝试（例如 `ominous_bottle` 不详之瓶）；这类物品不会出现在"自动择优"的候选里
- 冲突时**跳过本次**、不打断操作：容器界面开着、正在使用手持物品、钓鱼中、攻击或挖掘进行中；会在冷却后自动重试
- 进食完成后，临时换到主手的物品会**还原回原槽位**

命令：

| 命令 | 说明 |
| --- | --- |
| `eat <物品id>` | 手动吃一次（两种模式都可用）；满饱食度吃普通食物会被**立即拒绝**，白名单物品（如不详之瓶）不受限制 |
| `autoeat on\|off\|status` | 运行时开关与查看，不需要重启 |

状态：`getActionState()` 会带 `autoEatEnabled` / `autoEating`，面板可读。

### 4.10 `blockBreakDetection`

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

### 4.11 `monitoring`

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `monitoring.enabled` | boolean | `false` | 是否启用实体监控 |
| `monitoring.intervalSeconds` | number | `10` | 扫描间隔，秒 |
| `monitoring.targetTypes` | string[] | `["minecraft:wandering_trader", "minecraft:trader_llama"]` | 监控目标类型 |

说明：

- 类型会统一规范化，小写并去掉 `minecraft:` 前缀再比较
- 如果 `targetTypes` 为空，则默认只监控 `mob`
- 结果会去重并记录到 bot 目录下固定的 `found.txt`

### 4.12 `recording`

这是当前字段最多的一块。

#### 基础控制

| 字段 | 类型 | 代码默认 | 说明 |
| --- | --- | --- | --- |
| `recording.enabled` | boolean | `false` | 是否启用本地可选录制器；缺少模块时状态为 `unavailable` 且不影响 Bot 启动 |
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

`RecorderFeature` 是本地可选模块的适配层。没有本地模块时，录制相关命令仍可查询状态或安全结束空实现，其余 Bot 功能保持可用。

### 4.13 能力开关与录制器联动

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
