# MULTIBOT

`MULTIBOT` 是一个基于 `mineflayer` 的单进程多 bot 管理后端，用于 Minecraft 挂机 bot 的集中运行与控制。

核心能力：

- **多实例管理**：通过 `BOTS/<server>/<bot>` 目录发现集中管理任意数量的 bot 实例，支持启动、停止、重启与断线自动重连
- **多种控制方式**：游戏内 whisper 私聊命令、HTTP API、SSE 事件流，以及 `console-connector` 控制台连接器
- **挂机与行为**：移动、挖掘、放置、钓鱼、进食、攻击、骑乘、脚本调度等按配置启用的行为能力
- **物品与容器**：背包查看/移动、箱子存取、快捷栏切换
- **录制回放接口**：支持加载本地可选录制器；公开仓库不包含录制器实现
- **账户会话**：Microsoft 会话缓存与 OpenAuth 设备码登录，支持离线模式与代理场景

技术栈：Node.js + `mineflayer` / `minecraft-protocol`，目标 Minecraft 版本 1.21.x。

如果你想看当前后端的实现细节、模块关系和启动/配置/录制链路，见 `MULTIBOT/TECHNICAL_ARCHITECTURE.md`。
如果你想系统查看所有 JSON 配置项、默认值、合并规则和推荐写法，见 `MULTIBOT/CONFIGURATION_GUIDE.md`。

## 版权声明

本项目代码保留所有权利（All Rights Reserved）：未经作者书面许可，不得复制、修改、分发或用于商业用途。

例外：`patches/` 目录下的补丁文件，以及与 `mineflayer`、`minecraft-protocol` 等本体相关的代码，遵循其各自的原始许可证（MIT / BSD-3-Clause）规定。

公开仓库不包含 `flashback-recorder` 的实现。`RecorderFeature` 只是可选本地模块的适配层；缺少该模块时录制状态为 `unavailable`，不会阻止 MULTIBOT 或 Bot 启动。本项目不是 Flashback 官方项目，不代表与其作者存在关联，也不声明获得其授权。

## 当前范围

- 单进程管理多个 bot runtime
- 复用旧账户目录与配置目录结构
- 复用的旧逻辑统一收在 `MULTIBOT/src/legacy`
- Microsoft 会话缓存独立保存在 `MULTIBOT/sessions`
- Microsoft / Prismarine Auth 底层缓存独立保存在 `MULTIBOT/auth-cache`
- 通过 HTTP API 控制 bot 的启动、停止、重启、命令执行
- 通过 SSE 输出 bot 状态和日志
- 通过实例管理 API 维护 `MULTIBOT/BOTS` 下的实例目录

## 支持的命令

- `health`
- `getpos`
- `send <内容>`
- `broadcast send <内容>`
- `broadcast inv <子命令>`
- `broadcast eat <物品id>`
- `inv ...`
- `chest <info|move|close|help>`
- `changeslot <1-9>`
- `changeslot info`
- `look <yaw> <pitch>`
- `goto <x> <y> <z> [选项...]`（选项: sprint/dig/tower/parkour，可组合；默认仅普通走路）
- `shift`
- `circle`
- `ride`
- `fish`
- `eat <itemId>`
- `attack @n`
- `interact @n`
- `useblock <x> <y> <z>`
- `cuseblock <x> <y> <z>`
- `stopplace`
- `dig <x> <y> <z>`
- `dig <x1> <y1> <z1> <x2> <y2> <z2>`
- `stopdig`
- `cplace`
- `stopcplace`
- `vault`
- `script <文件>`
- `stopscript`
- `reloadwhitelist`
- `recordstatus`
- `finishrecord`
- `abortrecord`
- `entity list`
- `lock` / `unlock`

## 已支持配置

- `protocolGuard.logParseErrors`
- `diagnostics.memoryLogger`
- `diagnostics.memoryDetails`
- `diagnostics.apiAccessLogger`
- `aggregateLogging`
- `consoleConnector.historyLimit`
- `checkTimeoutInterval`
- `restartOnDisconnect`
- `restartDelayMs` / `restartJitterMs`
- `capabilities.entityHandling`
- `capabilities.terrainHandling`
- `trustedPlayersFile`
- `attack.autoAttack`
- `blockBreakDetection`
- `monitoring`
- `logging.logToFile`
- `logging.logPlayerList`
- `fish: true`
- `ScriptScheduler`
- `recording`
- `behavior.enableResourcePack`
- `server.json -> openAuth`：通过本机 ViaProxy/OpenAuth 连接 26.1.2
- 旧版 `autoRestart`：bot `spawn` 后按分钟数主动重启

默认情况下，回放会导出到 `MULTIBOT/replays`。  
如果某个 bot 单独设置了 `recording.outputDir`，则仍按该 bot 配置导出。

临时内存监测启用后，会按间隔把整进程内存采样写到 `MULTIBOT/logs/memory-monitor.log`。  
每一行都是一条 JSON 记录，包含 `rssMB`、`heapUsedMB`、`heapTotalMB`、bot 数量和 bot 状态摘要。
如果 `diagnostics.memoryDetails.enabled=true`，内存日志还会加入每个 bot 的 `worldColumns`、实体数量、玩家数量和区块包计数，并启用 `GET /api/diagnostics/memory`。关闭时这些详细字段不会被采集。

后端 API 访问日志默认启用，会把所有 HTTP 访问写到 `MULTIBOT/logs/api-access.log`。  
其中包括：

- 正常合法请求
- 401 未授权请求
- 404 / 405 / 400 等异常请求
- 明显异常的低层 HTTP 解析错误（例如网络扫描、畸形请求）

每一行都是一条 JSON 记录，默认会包含请求方法、URL、状态码、耗时、来源地址、鉴权摘要和已脱敏的请求头。
请求正文默认不写入访问日志；仅在 `diagnostics.apiAccessLogger.includeBodyPreview=true` 时记录脱敏后的预览。

浏览器跨域访问受 `api.allowedOrigins` 限制；无 `Origin` 请求头的控制台和脚本客户端不受影响。JSON 请求体默认限制为 1 MiB，SSE 默认最多允许 32 个并发客户端。

服务端聚合日志启用后，会按 `serverDir` 写入：

- `MULTIBOT/BOTS/<serverDir>/<serverDir>_chat.log`
- `MULTIBOT/BOTS/<serverDir>/<serverDir>_playerList.log`

聚合日志只对 `MULTIBOT/BOTS/<serverDir>/<botDir>` 这类实例生效；legacy 显式 bot 不参与聚合。
聚合聊天日志里，如果一条消息在聚合窗口内只由单个 bot 上报，会额外写成 `[账号名] 消息内容`；若同窗内有多个 bot 上报同一条消息，则仍只写原消息一次，不附带来源。

## 目录约束

- 复用的旧逻辑统一收在 `MULTIBOT/src/legacy`，不在 MULTIBOT 外引用代码
- 本地录制器可放在被 Git 忽略的 `MULTIBOT/flashback-recorder`；公开仓库不分发该目录

## 共享默认配置

在 `MULTIBOT/BOTS/<serverDir>` 下，除了 `server.json` 之外，现在还支持一个共享的 `default.config.json`。

- `server.json`：共享连接/运行时字段
- `server.json -> teleportPromptMatchers`：同服共享的严格 TPA/TPAHERE 文本追加规则
- `server.json -> openAuth`：同服共享的 ViaProxy/OpenAuth 认证开关
- `default.config.json`：共享 bot 侧 `config.json` 默认项
- `<botDir>/config.json`：当前实例自己的配置

合并优先级：

- 当前实例 `config.json`
- 共享 `default.config.json`
- MULTIBOT 内建默认值

## 断线随机重连

现在同服实例可以在 `MULTIBOT/BOTS/<serverDir>/server.json` 中配置断线重连打散：

```json
{
  "restartDelayMs": 60000,
  "restartJitterMs": 120000
}
```

含义：

- `restartDelayMs`
  - 基础重连延迟
- `restartJitterMs`
  - 随机附加延迟上限
- 实际重连时间
  - `restartDelayMs + random(0..restartJitterMs)`

以上例为例，常规断线后的实际重连时间范围就是 `60 ~ 180 秒`。

说明：

- 推荐把这个策略放在 `server.json`，因为它本质上是同服共享策略
- 兼容现有 runtime override 规则，仍允许 bot 级配置覆盖
- `connection.restartJitterMs` 也可以生效
- 内建默认值就是 `restartDelayMs = 60000`、`restartJitterMs = 120000`

作用范围：

- 只作用于常规 `disconnect` 重连
- 不作用于后端启动时的 `autoStart`
- 不作用于 `invalid_session_retry`
- 不作用于 `retryable_error`
- 不作用于手动 `restart`

### 可选的分级重连

同服可以在 `server.json` 顶层配置分级重连数组，让重连延迟随失败次数逐步拉长：

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

- `restartDelayScheduleMs`：可选的分级基础延迟数组，毫秒，允许值为 `0`；缺省表示未启用分级策略。
- 第一次自动重连使用数组第一项，第二次使用第二项，依此类推。
- 每一级实际延迟 = 当前级基础延迟 + `random(0..restartJitterMs)`。
- `restartDelayScheduleRepeatLast`：`true`（默认）表示数组耗尽后重复最后一级；`false` 表示耗尽后停止自动重连。
- 数组有 7 项且 `restartDelayScheduleRepeatLast=false` 时，最多安排 7 次分级自动重连，第 7 次仍未成功 `spawn` 后进入耗尽停止状态。
- ViaProxy 后端不可达（`Could not connect to the backend server!`、`An error occurred while connecting to the backend server: ...`）和普通断线共用同一套延迟策略：配置了数组就按分级，没配置就沿用 `restartDelayMs + restartJitterMs`。
- `restartOnDisconnect: false` 优先级最高，直接禁止自动重连。

这两个新字段只从 `server.json` 顶层读取，同一服务器目录下所有 Bot 共享，Bot 配置不能覆盖。字段一旦存在必须是非空数组，元素必须是大于等于 0 的整数；空数组、负数、小数、数字字符串和非数组值会返回明确配置错误。

## KeepAlive 超时

`server.json` / `connection` 可以配置客户端等待服务端 keepalive 的本地超时时间：

```json
{
  "connection": {
    "checkTimeoutInterval": 120000
  }
}
```

- 默认值：`30000`
- 单位：毫秒
- 作用：传给 mineflayer，再由 `minecraft-protocol` 的客户端 keepalive 检测使用
- 主要影响：减少服务端短暂卡顿时本地报 `client timed out after ... milliseconds` 并主动断开的概率
- 不保证解决：服务端、代理或网络直接触发的 `read ECONNRESET`

## 通过 ViaProxy + OpenAuth 连接 26.1.2

当目标服务端强制要求 Minecraft `26.1.2`，而当前 Mineflayer 仍使用 `1.21.11` 客户端协议时，可以让所有同服 bot 连接本机 ViaProxy，再由 ViaProxy 将协议转换到目标服：

升级后启动首行应显示 `MULTIBOT V26.3.6-OpenAuth`，可用它确认运行的不是旧进程或旧 Git 版本。

```text
MULTIBOT (1.21.11) -> 127.0.0.1:25568 -> ViaProxy (target-version 26.1.2) -> 目标服务器
```

这一方案不要求把每个 Microsoft 账号重新登录到 ViaProxy。MULTIBOT 继续使用自己的 `auth: "microsoft"` 会话，只向 ViaProxy 返回 OpenAuth 请求的成功/失败结果。ViaProxy 工作目录中不要添加账号。

### 固定版本

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Java | 17 | 运行 ViaProxy 与 OpenAuth 插件 |
| [ViaProxy 3.4.12](https://github.com/ViaVersion/ViaProxy/releases/tag/v3.4.12) | 3.4.12 | 包含 26.2 支持，覆盖 26.1.2 |
| ViaProxyOpenAuthMod | 1.0.2 | 在 ViaProxy 中启用 `OPENAUTHMOD` |
| MULTIBOT 客户端协议 | 1.21.11 | Mineflayer 当前支持的客户端版本 |

插件下载：[ViaProxyOpenAuthMod 1.0.2](https://github.com/ViaVersionAddons/ViaProxyOpenAuthMod/releases/tag/v1.0.2)。将 JAR 放在 ViaProxy 工作目录的 `plugins/` 下；插件只能在启动时加载，替换 JAR 后必须重启 ViaProxy。

### ViaProxy 配置

建议为每个目标服务器建立独立的 ViaProxy 工作目录，并在其中放置 `ViaProxy-3.4.12.jar`、`plugins/ViaProxyOpenAuthMod-1.0.2.jar` 和 `viaproxy.yml`。配置文件的目标地址是实际的 26.1.2 服务器，MULTIBOT 的 `server.json` 地址则是本机代理入口：

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

使用 Java 17 启动（首次运行会生成配置并退出）：

```powershell
cd D:\ViaProxy\server-26.1.2
java -version
java -jar .\ViaProxy-3.4.12.jar config .\viaproxy.yml
```

不要从随机目录启动。ViaProxy 会按工作目录寻找 `plugins/`、配置和日志；需要固定目录时可设置 `VP_RUN_DIR`。

### `server.json` 示例

启用 OpenAuth 时，`host`/`port` 是 Bot 要连接的 ViaProxy 入口，不是目标服务器地址：

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

`openAuth` 只能放在 `server.json` 顶层，不会从 `default.config.json`、单 bot `config.json` 或面板配置读取。启用后，服务端的 `host`、`port`、`auth`、`version` 会被锁定，单 bot 覆盖不会绕过代理。

代理入口如果使用域名，MULTIBOT 每次连接前只做一次 A/AAAA 解析：解析必须在 3 秒内完成，所有返回地址都必须是回环地址（IPv4 `127.0.0.0/8` 或 IPv6 `::1`），随后优先选择 IPv4 并使用已验证的固定 IP 建立 TCP 连接，同时保留原域名写入 Minecraft handshake。不会执行 SRV 查询，也没有可配置的 `connectionIP` 字段。可通过 DNS 或 Windows hosts 文件把 `viaproxy.local` 指向 `127.0.0.1`。

### 协议边界与故障表现

- 当前只接受客户端协议 `1.21.11`、目标 ViaProxy 版本 `26.1.2`，并要求 `auth: "microsoft"`。
- 认证请求使用 `oam:join`；登录阶段使用 login plugin query，重连/转移阶段使用对应的 play custom payload。未知频道、畸形数据、重复请求 ID 和过长的 server hash 会被拒绝。
- `requestTimeoutMs` 默认 `4500`，只接受 `1000` 到 `5000` 的整数毫秒值；非法值会阻止配置加载。ViaProxy 插件约在 6 秒后超时，因此不要设置更大的值。
- Token 只在 MULTIBOT 到 Mojang Session Server 的请求中使用，日志和发给 ViaProxy 的响应不包含 Token。Mojang 失败、会话失效或超时会返回明确的认证失败并按现有重连策略处理。
- Mojang 返回 `401/403` 或当前短期 session 不可用时，只删除 MULTIBOT 自有 session，并在 1 秒后通过现有 auth-cache 刷新；`429`、`5xx`、网络错误和超时保留缓存并走普通退避。
- 有效 `oam:join` 请求一到达就会清除 10 秒看门狗，不需要等待 Mojang Session Server 返回；认证请求自身仍受 `requestTimeoutMs` 限制。
- 首次或手动启动时，代理连接后 10 秒内没有发出 `oam:join` 会停止该 bot 并记录 `OPENAUTH_REQUEST_MISSING`。这可防止 ViaProxy 未运行、端口冲突、插件缺失或版本不兼容时持续重试，也不会静默绕过 OpenAuth 直连目标服。
- 已经成功 `spawn` 过的 bot 在自动重连中遇到 `OPENAUTH_REQUEST_MISSING` 时，会按 `restartOnDisconnect`、`restartDelayScheduleMs`、`restartDelayScheduleRepeatLast`、`restartDelayMs` 和 `restartJitterMs` 的现有策略继续尝试。手动启动不会继承这一放宽条件。
- 如果首次或手动启动因代理问题停止，应先修复代理启动日志中的 `Loaded/Enabled plugin 'OpenAuthModPlugin'` 和监听地址，再手动启动 Bot。
- ViaProxy 或目标服发来的 `player_chat` 如果缺少签名和未签名内容标记，MULTIBOT 会在验签前将它规范化为未签名消息并保留正文，避免 `crypto.verify` 参数错误中断收包并连带触发 keepalive 超时。`disableChatSigning` 只控制客户端自身是否获取签名证书，不控制入站消息格式。
- OpenAuth 解决的是在线会话认证，不保证服务端强制安全聊天时的签名能力；请单独验收聊天、命令和传送功能。
- 一个 ViaProxy 进程只有一个 `target-address`；同一目标的多个 bot 可共用它，不同目标服务器应使用不同工作目录和 loopback 端口。

### 启动与停止顺序

1. 启动 ViaProxy，确认插件已加载、`OPENAUTHMOD` 配置生效并监听 `127.0.0.1:25568`。
2. 先用 Minecraft 状态 ping 验证代理能访问目标服，再启动 MULTIBOT 的 canary bot；TCP 端口可用不等于 OpenAuth 全链路可用。
3. 验证 canary 成功后再启动同服其他 bot，避免同时触发大量 Mojang 会话请求。
4. 停止时先停止相关 bot，再停止 ViaProxy；重启时反向执行。

## 能力开关

现在每个 bot 的 `config.json` / `default.config.json` 都可以配置：

```json
{
  "capabilities": {
    "entityHandling": true,
    "terrainHandling": true
  }
}
```

默认值：

- `entityHandling: true`
- `terrainHandling: true`

用途：

- `entityHandling=false`
  - 禁用 `attack @n`、`interact @n`、`ride`、`fish`、`entity list`
  - 禁用 `attack.autoAttack`、`fish: true` 自动开钓、`monitoring`
  - 录制器退化为仅保留本体实体轨迹
- `terrainHandling=false`
  - 禁用 `goto`、`useblock`、`cuseblock`、`dig`、`vault`、`cplace`
  - 禁用 `blockBreakDetection`
  - 录制器关闭世界快照、后续区块加载、方块实体更新和 chunk cache

以下命令不依赖地形处理，`terrainHandling=false` 时仍保留：

- `look`
- `shift`
- `circle`
- `eat`
- `inv`
- `send`

这两个开关是**功能级禁用**，不是对 mineflayer 底层协议解析的彻底关闭。  
主要减少的是 pathfinder、feature、轮询、录制器附加处理等额外开销，不等于完全不维护内部实体/世界状态。

### 共享默认配置示例

`MULTIBOT/BOTS/<serverDir>/default.config.json`

```json
{
  "capabilities": {
    "entityHandling": false,
    "terrainHandling": true
  }
}
```

`MULTIBOT/BOTS/<serverDir>/<botDir>/config.json`

```json
{
  "capabilities": {
    "entityHandling": true
  }
}
```

最终该实例会得到：

```json
{
  "capabilities": {
    "entityHandling": true,
    "terrainHandling": true
  }
}
```

也就是仍然遵循“实例 `config.json` 优先于共享 `default.config.json`”。

## 受信任玩家热重载

`trustedPlayers` 控制谁可以私聊 bot 执行命令，也控制 `tpahere` 是否允许。除了 JSON 数组外，也可以配置热重载文件：

```json
{
  "trustedPlayersMergeParent": true,
  "trustedPlayers": ["example_player"],
  "trustedPlayersFile": "../trustedPlayers.txt"
}
```

`trustedPlayers.txt` 写法：

```txt
example_player
example_trusted
playerName
```

- 有效名单 = `trustedPlayers` 数组 + `trustedPlayersFile` 文件内容
- 如果设置 `trustedPlayersMergeParent: true`，当前实例的 `trustedPlayers` 会和上层 `default.config.json` 的同名名单合并
- 如果没有开启 `trustedPlayersMergeParent`，`trustedPlayers.txt` 也不会参与最终名单
- 文件路径相对 bot 目录解析
- 空行和 `#` 开头的行会被忽略
- 文件保存后会通过 `fs.watch` 自动刷新，不需要 `reloadwhitelist`
- `whitelist.txt` 只控制普通 TPA；`trustedPlayers` / `trustedPlayersFile` 控制私聊命令和 `tpahere`
- 白名单和脚本定时执行的完整示范见 `CONFIGURATION_GUIDE.md`

## 新环境安装

`MULTIBOT` 是独立 Node.js 项目，新设备部署时在本目录安装依赖：

```powershell
cd MULTIBOT
npm.cmd install
```

安装后会通过 `postinstall` 自动执行 `patch-package`，应用 `patches/minecraft-protocol+1.64.0.patch`。这个补丁用于让 `minecraft-protocol@1.64.0` 识别 `MULTIBOT/sessions` 中的缓存 Microsoft 会话，避免缓存存在时仍反复要求重新登录。

如果 PowerShell 阻止直接执行 `npm`，使用 `npm.cmd`。

## 启动

```powershell
cd MULTIBOT
.\start-multibot.ps1
```

或指定配置文件：

```powershell
cd MULTIBOT
.\start-multibot.ps1 -ConfigPath .\multibot.config.json
```

也可以直接运行入口：

```powershell
cd MULTIBOT
node .\index.js
```

兼容批处理入口：

```powershell
cd MULTIBOT
.\start-multibot.bat
```

默认配置见 `MULTIBOT/multibot.config.json`：

- API 地址：`http://127.0.0.1:18080`
- 实例发现目录：`MULTIBOT/BOTS`
- 同服共享重连策略：`BOTS/<serverDir>/server.json` 中的 `restartDelayMs` / `restartJitterMs`
- 同服 keepalive 超时策略：`BOTS/<serverDir>/server.json` 中的 `checkTimeoutInterval`
- 协议解析噪声日志：`protocolGuard.logParseErrors`
- 微软底层认证缓存目录：`MULTIBOT/auth-cache`
- 临时内存采样日志：`diagnostics.memoryLogger.filePath`
- 每 bot 详细内存诊断开关：`diagnostics.memoryDetails.enabled`
- API 访问日志：`diagnostics.apiAccessLogger.filePath`
- 服务端聚合日志：`aggregateLogging`
- 单实例瘦终端历史日志上限：`consoleConnector.historyLimit`

如果你想启用按 `serverDir` 聚合的聊天日志与玩家列表日志：

```json
{
  "aggregateLogging": {
    "enabled": true,
    "chat": true,
    "playerList": true,
    "chatBatchWindowMs": 100,
    "playerListIntervalMinutes": 1
  }
}
```

如果你想只保留聚合日志，而关闭单实例自己的聊天/玩家列表文件，可以在对应 bot 的 `config.json` 里写：

```json
{
  "logging": {
    "logToFile": false,
    "logPlayerList": false
  }
}
```

当你不想在控制台里看到这类协议解析噪声时：

```json
{
  "protocolGuard": {
    "logParseErrors": false
  }
}
```

这会抑制例如 `PartialReadError: Read error for undefined : varint is too big: 70` 以及已忽略的同类协议解析警告输出，但不会关闭正常的连接/踢出/启动超时错误。

## 单实例瘦终端连接器

现在可以把旧单实例进程改成一个只负责“连后端、显示日志、转发控制台输入”的轻量连接器。

它的边界是：

- 不自己登录 Minecraft
- 不自己运行 bot 逻辑
- 只连接 `MULTIBOT` 后端里某一个 bot
- 只负责历史日志、实时日志、控制台输入转发和 `/start`

启动方式只支持命令行参数，不支持环境变量：

```powershell
cd MULTIBOT
node .\console-connector.js --bot-id example_bot --api-base http://127.0.0.1:18080 --token change-me
```

可选参数：

- `--sender <name>`
  - 默认 `panel_connector`

后端历史日志上限由 `MULTIBOT/multibot.config.json` 控制：

```json
{
  "consoleConnector": {
    "historyLimit": 300
  }
}
```

语义说明：

- 连接器首次连上某个 bot 时，会打印最多 `historyLimit` 条历史日志
- 如果只是同一个后端进程内的短暂断线重连，不会重复打印这批历史日志
- 如果后端整个进程重启了，连接器会把新的历史日志再打印一次
- 后端断开时，连接器只打印一次“实例已离线”，然后在后台持续重连
- 离线时输入 `/start`
  - 会先立即尝试重连后端
  - 连上后调用 `POST /api/bots/:id/start`
  - 连不上则直接提示失败，不缓存命令
- 离线时输入其他内容
  - 不缓存
  - 直接提示“后端未连接，无法发送控制台输入”

## 配置生效说明

修改实例 `config.json` 或共享 `default.config.json` 后，需要通过实例同步路径生效，例如：

- 面板实例管理里的更新/保存
- `InstanceService.updateInstance(...)` 对应的实例 API
- 或直接重启整个 MULTIBOT 进程

单独调用 `POST /api/bots/:id/restart` 只会重启当前 runtime，不会重新扫描磁盘上的实例配置文件。

## API

所有 API 都需要：

```text
Authorization: Bearer <token>
```

### 可用接口

- `GET /api/bots`
- `GET /api/bots/:id`
- `POST /api/bots/:id/start`
- `POST /api/bots/:id/stop`
- `POST /api/bots/:id/restart`
- `POST /api/bots/:id/command`
- `GET /api/bots/:id/console-stream`
- `GET /api/instances`
- `GET /api/instances/:serverDir/:botDir`
- `POST /api/instances`
- `PATCH /api/instances/:serverDir/:botDir`
- `PUT /api/instances/:serverDir/:botDir`
- `DELETE /api/instances/:serverDir/:botDir`
- `GET /api/events`

### `GET /api/bots/:id/console-stream`

这是给单实例瘦终端连接器用的 bot 级 SSE。

行为：

- 连接建立后先发一条 `bootstrap`
- `bootstrap` 里包含：
  - `backendSessionId`
  - `backendStartedAt`
  - `historyLimit`
  - 当前 bot 的 detail
  - 该 bot 最近的历史日志
- 后续持续推送：
  - `log`
  - `botStatus`
- 心跳为每 `15s` 一次 SSE comment ping

它和全局 `GET /api/events` 的区别是：

- `console-stream` 只看单个 bot
- `GET /api/events` 是全局广播流
- `GET /api/events` 建连时也会先发一条 `bootstrap`
- 全局 `bootstrap` 包含 `backendSessionId`、`backendStartedAt`、`historyLimit`、`bots`、`logsByBotId`
- `logsByBotId` 会按 bot id 分组返回最近历史日志，用于面板补回连接前或重连期间错过的启动/错误日志

### `POST /api/bots/:id/command`

这个接口现在支持两种调用方式。

#### 1. 直接命令模式

适合后端、脚本或你明确知道要走 dispatcher 的场景。

```json
{
  "command": "health",
  "source": "http",
  "sender": "panel"
}
```

特点：

- 直接进入命令分发器
- 不做“旧版控制台”聊天兜底
- 未识别命令会返回提示消息

#### 2. 控制台输入模式

适合网页面板，行为与聊天控制台一致。

```json
{
  "input": "/health",
  "source": "console",
  "sender": "panel"
}
```

行为规则：

- 不以 `/` 开头：直接当聊天发送
- 以 `/` 开头：去掉前缀后按控制命令执行
- 以 `/` 开头但未命中命令：原样作为聊天发送
- 输入 `exit`：停止当前 bot 实例

### `POST /api/instances`

请求体示例：

```json
{
  "serverDir": "my_server_localhost",
  "botDir": "example_trusted",
  "server": {
    "host": "127.0.0.1",
    "port": 25565,
    "version": "1.21.11"
  },
  "bot": {
    "enabled": true,
    "autoStart": false,
    "email": "example-bot@example.com",
    "username": "example-bot@example.com",
    "trustedPlayers": ["example_player"]
  }
}
```

### `PATCH /api/instances/:serverDir/:botDir` / `PUT /api/instances/:serverDir/:botDir`

支持局部更新，例如：

```json
{
  "bot": {
    "teleport": {
      "whitelistFile": "trusted.txt"
    }
  }
}
```

如果你发送的是编辑器里的“完整文件内容”，并且希望删除旧字段也真正落盘，可以额外带上：

```json
{
  "replace": true
}
```

此时 `server` / `defaultBotConfig` / `bot` 会按整文件替换保存，而不是深合并。

实例管理默认操作 `MULTIBOT/BOTS` 目录树，并会把变更热同步到当前进程里的 runtime。

## `GET /api/bots` / `GET /api/bots/:id` 返回补充信息

除了基础 bot 信息外，目前还会返回：

- `actions`：`fishing`、`riding`、`circling`、`sneaking`、`digging`、`areaDigging`、`scriptRunning`
- `restart`：断线重连策略、旧版 `autoRestart` 调度状态、待执行重启原因
- `logs`：最近日志
- `recorderStatus`：录制器状态

## 当前行为差异 / 兼容说明

- `broadcast` 在 MULTIBOT 中改为进程内广播，不再依赖旧版 UDP 广播客户端
- `broadcast` 当前仅支持三类子命令：`broadcast send <内容>`、`broadcast inv <子命令>` 和 `broadcast eat <物品id>`
- `broadcast inv dropall` 会对所有在线 bot 生效；锁期间会按 `inv` 命令读写属性继续受限，不可绕过
- `broadcast eat bread` 会让所有在线 bot 尝试执行 `eat bread`；锁期间同样不会被 `broadcast` 绕过
- `reloadwhitelist` 使用显式缓存与 `fs.watch` 自动刷新，不再每次请求都读文件
- `trustedPlayersFile` 可追加私聊控制 / `tpahere` 的受信任玩家，并通过 `fs.watch` 自动热重载
- 旧配置里的 `behavior.whitelistReloadMinutes` 目前仅为兼容保留，不再驱动定时刷新
- `dig x1 y1 z1 x2 y2 z2` 为按层范围挖掘，`stopdig` 可中断
- `script` 只解析 bot 自己目录和 `MULTIBOT/scripts`
- `exit` 不走普通 dispatcher 命令；在“控制台输入模式”中会停止当前 bot，整个进程退出仍应使用 `SIGINT` / `SIGTERM`
- `behavior.enableSpawnActions` 未实现，建议改用 `ScriptScheduler` 或 `script`
