# MULTIBOT 技术实现文档

本文档面向后续维护者，说明 `MULTIBOT` 后端当前是如何组织、启动、装配、运行与扩展的。

它不是用户使用手册；命令列表、配置示例、API 用法以 `MULTIBOT/README.md` 为主。  
本文更关注“为什么这样设计”和“代码里具体是怎么串起来的”。

---

## 1. 项目定位

`MULTIBOT` 的核心目标不是从零设计一个全新的 bot 框架，而是：

- 以 **单进程、多 bot runtime** 的形式管理多个 `mineflayer` 实例
- 把已验证的挂机、控制、录制能力组织成可维护模块
- 同时保留既有配置习惯、命令语义和目录结构的高保真兼容

当前设计的关键词是：

- **稳定兼容**
- **命令对齐优先**
- **尽量不碰 mineflayer 内核**
- **通过 HTTP / whisper / 面板统一控制**

因此，`MULTIBOT` 的设计重点不是“抽象最优”，而是“稳定兼容既有行为并持续演进”。

---

## 2. 顶层架构

### 2.1 运行模型

`MULTIBOT` 是一个单 Node.js 进程，内部维护多个 `BotRuntime`。

可以把它理解成下面这层关系：

```text
MultibotApp
├─ loadMasterConfig()
├─ EventStream
├─ SessionService
├─ AggregateLogService
├─ BotManager
│  ├─ BroadcastService
│  ├─ ChatConsoleCoordinator
│  └─ BotRuntime x N
├─ MemoryLogService
├─ InstanceService
└─ HttpApiServer
```

其中：

- `MultibotApp` 负责总装配和生命周期
- `BotManager` 负责管理多个 runtime
- `BotRuntime` 是单个 bot 的完整运行单元
- `HttpApiServer` 提供控制面 API
- `EventStream` 提供 SSE 实时事件流
- `InstanceService` 管理 `BOTS/` 目录中的实例文件
- `SessionService` 负责 `MULTIBOT/sessions`
- `createAuthCacheFactory()` 负责 `MULTIBOT/auth-cache`
- `RecorderFeature` 提供可选本地录制器适配；公开仓库不包含录制器实现

### 2.2 代码目录职责

```text
MULTIBOT/
├─ index.js
├─ multibot.config.json
├─ BOTS/
├─ auth-cache/
├─ sessions/
├─ replays/
├─ logs/
├─ flashback-recorder/       # 本地可选目录，Git 忽略且不公开分发
└─ src/
   ├─ app/
   ├─ command/
   ├─ config/
   ├─ control/
   ├─ features/
   ├─ legacy/
   ├─ logging/
   ├─ runtime/
   ├─ session/
   └─ util/
```

主要职责如下：

- `index.js`
  - 进程入口，创建 `MultibotApp` 并绑定 `SIGINT` / `SIGTERM`
- `src/app`
  - 应用总装配与整体启动/关闭
- `src/config`
  - 主配置加载、legacy bot 配置归一化、实例目录管理
- `src/runtime`
  - bot 生命周期、feature 装配、状态汇总、命令执行
- `src/command`
  - 命令上下文、命令分发、能力门禁、帮助文本
- `src/control`
  - HTTP API、SSE、广播服务
- `src/features`
  - 单 bot 的业务功能模块
- `src/logging`
  - bot 日志、主控制台协调、聚合日志、内存日志
- `src/session`
  - 认证 session 与底层 auth cache 处理
- `flashback-recorder`
  - 本地可选录制器目录，不属于公开仓库内容
- `src/legacy/assn`
  - 允许复用的旧模块复制件

---

## 3. 启动链路

### 3.1 入口

进程入口在 `MULTIBOT/index.js`。

启动流程大致是：

1. 解析配置文件路径
2. 创建 `MultibotApp`
3. 执行 `app.start()`
4. 绑定退出信号
5. 收到 `SIGINT` / `SIGTERM` 时调用 `app.stop()`

### 3.2 `MultibotApp.start()` 的装配顺序

当前后端启动顺序基本是：

1. `applyNetworkDefaults()`
   - 优先 IPv4
   - 关闭 Node 自动地址族选择
2. `loadMasterConfig()`
   - 读取 `multibot.config.json`
   - 发现 bot
   - 归一化主配置
3. `applyProtocolGuardHotfix()`
   - 应用协议防护热修
4. 创建基础服务
   - `EventStream`
   - `SessionService`
   - `AggregateLogService`
   - `BotManager`
   - `MemoryLogService`
   - `InstanceService`
   - `HttpApiServer`
5. 启动控制面与 bot
   - `httpApiServer.start()`
   - `botManager.start()`
   - `aggregateLogService.start()`
   - `memoryLogService.start()`

这个顺序的意义是：

- 先把配置和共享服务准备好
- 再启动 HTTP 控制面
- 最后启动 runtime 和后台日志服务

### 3.3 关闭顺序

关闭时走 `MultibotApp.stop(reason)`：

- 停 HTTP API
- 停所有 bot runtime
- 停聚合日志服务
- 停内存日志服务

这里的原则是：

- 先停止新的外部请求进入
- 再停止实际 bot 行为
- 最后做后台收尾

---

## 4. 配置系统

`MULTIBOT` 不是只有一个配置文件，而是分成了三层：

### 4.1 全局主配置：`multibot.config.json`

这层放 backend 级配置，例如：

- API 监听地址与 token
- 协议保护配置
- 内存日志配置
- 聚合日志配置
- bot 默认值
- 是否启用目录发现
- 显式 bots 列表

这部分由 `src/config/loadMasterConfig.js` 读取和归一化。

### 4.2 服务端共享配置：`BOTS/<serverDir>/server.json`

这层放同一个 `serverDir` 下所有 bot 共享的运行时字段，例如：

- `host`
- `port`
- `auth`
- `version`
- 连接级默认项

它更像“同服共享连接配置”。

### 4.3 服务端共享默认 bot 配置：`BOTS/<serverDir>/default.config.json`

这层放 bot 侧共享默认项，例如：

- `trustedPlayers`
- `trustedPlayersFile`
- `teleport`
- `logging`
- `recording`
- `capabilities`
- 各 feature 的默认配置

### 4.4 单实例配置：`BOTS/<serverDir>/<botDir>/config.json`

这层放当前 bot 自己的配置和覆盖项，例如：

- `email`
- `username`
- 特定录制配置
- 特定 trustedPlayers
- 特定 trustedPlayersFile
- 特定能力开关

### 4.5 受信任玩家热重载

`trustedPlayers` 仍按原有配置合并规则工作：实例 `config.json` 可以覆盖 `default.config.json`，数组本身不做自动追加合并。

新增的 `trustedPlayersFile` 是运行时追加名单：

- 路径相对 bot 目录解析
- 每行一个玩家名
- 空行和 `#` 开头的行会被忽略
- 文件内容与配置里的 `trustedPlayers` 合并为有效受信任玩家名单
- `TrustedPlayersStore` 使用 `fs.watch` 监听文件所在目录，并在变更后防抖刷新

该有效名单同时供：

- `ChatFeature` 判断谁可以私聊执行命令
- `TeleportFeature` 判断 `trustedPlayers` 模式和 `tpahere`

### 4.6 合并顺序

当前的配置优先级是：

1. 当前实例 `config.json`
2. `default.config.json`
3. 内建默认值

而连接/运行时字段还会再叠加：

1. `multibot.config.json` 的默认 runtime 值
2. `server.json`
3. 当前实例归并后的 bot 配置

### 4.7 两类配置加载器

#### `loadMasterConfig()`

负责：

- 读取主配置
- 归一化 API / diagnostics / aggregateLogging
- 解析显式 bots
- 自动发现 `BOTS/` 下的实例目录
- 构造最终 `masterConfig.bots`

#### `loadLegacyBotConfig()`

负责：

- 提供 bot 侧内建默认值
- 深合并 `default.config.json` 与实例 `config.json`
- 归一化既有配置字段
- 兼容既有配置结构

它的本质是：

- 把“旧 bot 配置风格”整理成 `BotRuntime` 能稳定消费的结构

---

## 5. bot 发现与实例模型

`MULTIBOT` 当前支持两种 bot 来源：

### 5.1 `MULTIBOT/BOTS` 目录发现模式

这是当前主流模式。

结构形如：

```text
BOTS/
└─ ASSN/
   ├─ server.json
   ├─ default.config.json
   ├─ example_bot/
   │  └─ config.json
   └─ example_trusted/
      └─ config.json
```

这类 bot 的 `sourceType` 是 `multibot_bots`。

特点：

- 参与实例管理 API
- 参与按 `serverDir` 的聚合日志
- 支持共享默认配置

### 5.2 legacy 显式 bot 模式

也支持通过主配置显式指定 legacy 目录下的 bot。

这类 bot 的 `sourceType` 是 `legacy_assn`。

特点：

- 保留旧账号目录结构
- 不参与 `BOTS/<serverDir>` 级别的聚合日志
- 更偏向兼容保底

### 5.3 `resolveBotPaths()` 的作用

`src/config/resolveBotPaths.js` 负责把不同来源的 bot 统一映射成一组标准路径：

- `legacyConfigPath`
- `defaultLegacyConfigPath`
- `serverConfigPath`
- `lockHistoryPath`
- `whitelistPath`
- `sessionsDir`
- `authCacheDir`
- `fallbackAuthCacheDir`

这让 runtime 层不需要关心 bot 来自哪里。

---

## 6. `BotManager`：多 runtime 管理中心

`BotManager` 是所有 bot runtime 的总入口。

### 6.1 它管理什么

- `Map<botId, runtime>`
- `Map<serverDir/botDir, runtime>`
- `BroadcastService`
- `ChatConsoleCoordinator`

### 6.2 它负责哪些行为

- 启动全部可自动启动的 bot
- 停止全部 bot
- 查询 bot summary / detail
- 启动 / 停止 / 重启某个 bot
- 执行命令
- 执行面板控制台输入
- 新增或替换某个实例的 bot 配置
- 删除某个实例对应的 runtime

### 6.3 runtime 热替换策略

实例更新不是“原地修改 runtime”，而是：

1. 找到旧 runtime
2. `stop()`
3. 从 `BotManager` 注销
4. 用新配置创建新 runtime
5. 重新注册
6. 按需要恢复运行状态

这样做的好处是：

- 状态更干净
- 不需要在所有 feature 里实现复杂的在线配置热切换
- 与当前“重建 runtime”的架构更匹配

代价是：

- 配置同步本质上是重建 runtime

---

## 7. `BotRuntime`：单个 bot 的完整生命周期

`BotRuntime` 是项目中最核心的类。

可以把它理解成“一个 bot 的容器”。

### 7.1 它持有什么

- 单个 bot 的标准化配置
- `mineflayer` bot 实例
- 当前状态字段
  - `stopped`
  - `starting`
  - `online`
  - `stopping`
- 最近错误、kick、失败信息
- restart timer
- legacy autoRestart timer
- feature 实例
- logger
- command dispatcher

### 7.2 典型启动流程

`start()` 大致做下面这些事：

1. 检查是否已在运行
2. 校验基础配置
3. 清理历史 restart / warning timer
4. 写启动日志
5. 构造认证状态
6. 读取缓存 session
7. 调用 `mineflayer.createBot()`
8. 绑定底层 client 事件
9. 绑定 bot 事件
10. 挂载各 feature
11. 发布状态到 SSE

### 7.3 认证接入点

`createMineflayerOptions()` 会把以下信息传给 `mineflayer`：

- `session`
  - 来自 `SessionService`
- `profilesFolder`
  - 实际上传入的是 `createAuthCacheFactory()` 返回的缓存工厂
- `onMsaCode`
  - 用于把微软设备码登录提示写入 bot 日志

### 7.4 停止流程

`stop()` 的核心逻辑是：

1. 标记 `desiredRunning = false`
2. 清理 restart / autoRestart timer
3. 先停止各 feature
4. 如果 bot 存在，先等待录制器 shutdown
5. 调用 `bot.quit()`
6. 等待 `end`
7. 切到 `stopped`
8. 发布最终状态

这里特别注意：

- 录制器是先收尾、再断 bot
- `stop()` 要求尽量完整释放 interval、listener 和后台动作

### 7.5 断线与重启

`BotRuntime` 内部实现了自动重启策略：

- 正常断线后按配置 delay 重启
- 某些错误会触发更快重试
- `ForbiddenOperationException` 会删除 session 并快速重试

同时还保留了 legacy `autoRestart`：

- bot `spawn` 后按分钟数主动重启

### 7.6 summary / detail 状态输出

`getSummary()` 用于 bot 列表视图，`getDetails()` 用于详情视图。

会包含：

- bot id
- serverDir / botDir
- 当前状态
- desiredRunning
- 最近错误 / kick / 失败原因
- 当前 action 状态
- `capabilities`
- 最近日志缓冲等补充信息

SSE 的 bot 状态更新也是从这里发出去的。

---

## 8. feature 模块化设计

`BotRuntime` 内部把大部分行为拆成 feature。

### 8.1 当前主要 feature

- `teleport`
- `inventory`
- `movement`
- `eat`
- `attack`
- `entityInteract`
- `blockUse`
- `dig`
- `cplace`
- `ride`
- `fish`
- `monitoring`
- `blockBreak`
- `activityLog`
- `recording`
- `script`
- `vault`
- `lock`
- `chat`

### 8.2 设计原则

feature 通常遵循以下模式：

- 构造时接收 config / logger / runtime 依赖
- `attach(bot)` 时绑定事件或初始化插件
- `stop()` 时清理 interval、timeout、event listener 级状态

这样做的好处是：

- 各功能职责清晰
- 可以按 capability 做条件挂载
- 停止流程容易统一收口

### 8.3 条件挂载

当前某些 feature 不是无条件挂载的。

例如：

- `entityHandling=true` 才挂载实体相关 feature
  - `attack`
  - `entityInteract`
  - `fish`
  - `monitoring`
- `terrainHandling=true` 才挂载地形相关 feature
  - `blockUse`
  - `dig`
  - `cplace`
  - `vault`
  - `blockBreak`
- `entityHandling && terrainHandling` 才挂载
  - `ride`

这意味着能力开关不仅是命令层拒绝，还会影响后台逻辑是否真正启动。

---

## 9. 命令系统

### 9.1 命令入口来源

当前命令主要有三种来源：

#### 1) 游戏内 whisper

- bot 接收到玩家私聊
- `ChatFeature` 解析后转给 runtime
- 创建 `CommandContext`
- 最终进入 `CommandDispatcher`

#### 2) HTTP API 直接命令

- `POST /api/bots/:id/command`
- 传 `command`
- `BotManager.executeCommand()`
- runtime 执行命令并返回消息数组

#### 3) 面板控制台输入

- 面板把输入传给 `POST /api/bots/:id/command`
- 使用 `input` 字段而不是 `command`
- `BotManager.executeConsoleInput()` 做旧控制台兼容

控制台输入模式下：

- `/health` 会被当命令
- 普通文本会被当聊天
- `/exit` 或 `exit` 会停止当前 bot
- 以命令前缀开头但未识别的输入，会回退成聊天发送

### 9.2 `CommandContext`

`CommandContext` 是命令执行时的统一回执容器。

它记录：

- `source`
- `sender`
- `label`
- `messages`
- `replyFn`

它的作用是把“命令执行结果”从执行逻辑里抽出来，使不同来源都能复用同一套返回模型。

### 9.3 `CommandDispatcher`

`CommandDispatcher` 是命令解析中心。

职责包括：

- 解析命令和参数
- 路由到对应 runtime/feature 方法
- 输出用法错误和失败信息
- 实现 `help`
- 实现能力门禁

当前它不仅分发命令，还承担一层“语义兼容器”的角色：

- 让旧命令语法尽量保持一致
- 在 MULTIBOT 架构下补齐必要回执

### 9.4 `LockFeature` 与命令权限

锁逻辑不是靠 API 层做，而是和命令分发绑定。

它的职责是：

- 记录某个 bot 当前是否被某玩家锁定
- 决定锁期间允许哪些 whisper 命令通过
- 防止 `broadcast` 这类命令绕过锁限制

这能保证：

- 命令来源不同，但权限语义尽量一致

---

## 10. 聊天、广播与面板联动

### 10.1 `BotLogger`

每个 runtime 自带一个 `BotLogger`：

- 日志会进入 ring buffer
- 会发到 `EventStream`
- 根据模式可打印到主控制台

因此面板能看到每个 bot 的最近日志，不需要直接读文件。

### 10.2 `EventStream`

`EventStream` 是一个简单的 SSE 发布器。

当前至少承担两类实时事件：

- `log`
- `botStatus`

面板通过 `/api/events` 订阅。

### 10.3 `ChatConsoleCoordinator`

这是“主后端控制台去重”的实现点。

它的目标不是修改每个 bot 自己的日志，而是：

- 当同一 `serverDir` 下多个 bot 在短窗口内收到同一条公屏消息
- 后端主控制台只打印一份
- 但各 bot 自己的日志流和面板日志仍保留各自语义

也就是说，它主要协调的是“后台主控制台输出”，不是取代 bot logger。

### 10.4 `BroadcastService`

当前广播服务支持两类广播：

- `broadcast send <内容>`
- `broadcast inv ...`
- `broadcast eat ...`

实现原则是：

- 聊天广播直接让在线 bot 发送聊天
- 命令广播只白名单少数命令族
- 命令广播使用内部 `CommandContext`
- 汇总结果，而不是给发起者回 N 份细节

这避免把 `broadcast` 做成“任意命令总线”。

---

## 11. 认证、会话与缓存

这是当前项目里最容易混淆的一部分。

### 11.1 两层缓存

#### 第一层：`MULTIBOT/sessions`

这层是“快速直用 session”。

特点：

- 由 `SessionService` / `SessionManager` 管理
- key 基本按邮箱文件名存储
- 内容是 `accessToken + selectedProfile` 风格的 session
- 启动时优先尝试读取

如果这层命中，`mineflayer.createBot()` 会直接拿到 `session` 参数。

#### 第二层：`MULTIBOT/auth-cache`

这层是 `prismarine-auth` / Microsoft 登录链路底层缓存。

特点：

- 实际通过 `profilesFolder` 机制接入
- 文件名是哈希后的 `*_live-cache.json` / `*_xbl-cache.json` / `*_mca-cache.json` 等
- 用于微软登录、Xbox token、Minecraft Services token 等底层缓存

### 11.2 当前主键策略

当前实现已经调整为：

- **新写入时优先按邮箱哈希作为主文件名**
- 同时兼容读取旧的“按用户名哈希”文件
- 如果命中兼容文件，会把内容迁移回当前主 `auth-cache`

这样做是为了：

- 和旧版单实例行为保持一致
- 同时兼容此前 MULTIBOT 里已经生成过的用户名哈希文件

### 11.3 fallback `nmp-cache`

如果 `MULTIBOT/auth-cache` 没有对应缓存，当前实现还会尝试读原版 `minecraft-folder-path` 下的 `nmp-cache`。

这使得：

- 从旧环境迁移过来的账号缓存，不一定需要立刻全部重登

### 11.4 `ForbiddenOperationException` 的处理

当 MoJang/Microsoft 会话失效时，runtime 会：

1. 记录错误
2. 删除第一层 `sessions` 缓存
3. 请求快速重试

之后如果底层 `auth-cache` 还能刷新出新 token，就能继续恢复；否则就会再次触发设备码登录。

---

## 12. 录制器实现

### 12.1 本地可选录制器边界

公开仓库只保留 `RecorderFeature` 适配层，不包含或分发 `MULTIBOT/flashback-recorder` 实现。本地开发可以在被 Git 忽略的同名目录中放置录制器；目录缺失时适配层提供 `unavailable` 空实现，不阻止 MULTIBOT 或 Bot 启动。该接口不代表与 Flashback 官方项目或其作者存在关联，也不声明获得其授权。

### 12.2 `RecorderFeature`

`RecorderFeature` 是 `BotRuntime` 和底层 recorder 的适配层。

它负责：

- 解析 bot 侧 `recording` 配置
- 计算 effective recorder options
- 决定输出目录
- 挂接 `physicsTick`、`move`、`entity` 等监听
- 关闭时收尾导出

### 12.3 effective options 机制

录制器不是直接裸用用户配置，而是先构造一份“有效配置”。

这样做有两个重要目的：

#### 1) 把默认行为集中

例如：

- 默认输出目录是 `MULTIBOT/replays`
- 默认自动在 `spawn` 后启动
- 默认在 bot end 时收尾

#### 2) 和 capability 联动

例如：

- `entityHandling=false`
  - `entityScope` 强制降为 `self_only`
  - 关闭 collect / hurt animation
- `terrainHandling=false`
  - 关闭 world snapshot
  - 关闭 later chunk loads
  - 关闭 block entity updates
  - 关闭 chunk cache

### 12.4 recorder 与 runtime 停机顺序

`BotRuntime.stop()` 会优先调用 recorder shutdown，再 quit bot。

这样是为了满足：

- `/exit` 时尽量先完成回放封口
- bot end 前有机会把 archive 或 flashback 输出落盘

---

## 13. 日志与观测

当前日志系统不是单一路径，而是多层并存。

### 13.1 per-bot 实时日志

来源：

- `BotLogger`

用途：

- 面板 bot 控制台
- SSE 实时流
- 后端观察单个 bot 行为

### 13.2 单实例文件日志

来源：

- `ActivityLogFeature`

用途：

- 兼容旧版 `assn_chat.log`
- 兼容旧版 `assn_playerList.log`

开关位置：

- bot 侧 `config.json -> logging`

### 13.3 服务端聚合日志

来源：

- `AggregateLogService`

当前做两件事：

- 聚合聊天日志
- 聚合玩家列表日志

它只对 `BOTS/<serverDir>/<botDir>` 实例生效。

### 13.4 内存日志

来源：

- `MemoryLogService`

它会定期写入 JSON 行：

- `rssMB`
- `heapUsedMB`
- `heapTotalMB`
- `stateCounts`
- `botStates`

这是一种轻量、后分析友好的观测方式。

### 13.5 API 访问日志

来源：

- `ApiAccessLogService`
- `HttpApiServer`

它的目标是：

- 记录所有后端 HTTP 访问
- 不只记录成功调用，也记录 401 / 404 / 405 / 400
- 记录底层 `clientError`，用于捕获扫描器或畸形请求

当前默认输出到：

- `MULTIBOT/logs/api-access.log`

格式是 JSON Lines，便于后续筛选、统计和排查。

默认会记录：

- 请求方法、URL、状态码、耗时
- 来源地址和端口
- user-agent / referer
- 鉴权摘要
- 脱敏后的请求头
- JSON 解析失败时的 body 片段
- 低层 HTTP 解析错误时的 raw packet 预览

---

## 14. 实例管理 API 与磁盘同步

### 14.1 为什么要有 `InstanceService`

`MULTIBOT` 当前不仅是“运行 bot”，还需要维护：

- `BOTS/` 目录
- `server.json`
- `default.config.json`
- `<botDir>/config.json`

这些文件不能让前端直接改，所以引入了 `InstanceService`。

### 14.2 主要能力

当前实例 API 支持：

- `GET /api/instances`
- `GET /api/instances/:serverDir/:botDir`
- `POST /api/instances`
- `PATCH/PUT /api/instances/:serverDir/:botDir`
- `DELETE /api/instances/:serverDir/:botDir`

### 14.3 创建实例

`createInstance()` 会：

1. 校验 `serverDir` / `botDir`
2. 在必要时创建 server 目录
3. 写 `server.json`
4. 写 `default.config.json`（如果传了）
5. 写当前 bot 的 `config.json`
6. 构建标准化 `botConfig`
7. 调用 `syncBotConfig()` 或 `syncServerDirectory()`

### 14.4 更新实例

`updateInstance()` 会：

- 按 patch 写磁盘配置
- 如果动了 `server.json` 或 `default.config.json`
  - 同步整个 `serverDir` 下所有 bot
- 如果只动当前 bot 配置
  - 只替换当前 runtime

### 14.5 一个重要边界

当前“普通 restart”和“重新读取磁盘配置”不是同一个动作。

也就是说：

- `POST /api/bots/:id/restart`
  - 只是重启当前 runtime
- `InstanceService.updateInstance(...)`
  - 才是磁盘配置写入 + runtime 重建

这是当前架构非常重要的语义边界。

---

## 15. 能力开关：`entityHandling` / `terrainHandling`

这部分是当前“轻量化实例”设计的主要入口。

### 15.1 设计目标

不是彻底修改 `mineflayer` 协议处理，而是：

- 在 feature 层明确禁用相关能力
- 在命令层明确拒绝相关命令
- 在 recorder 层同步收缩负担

### 15.2 影响范围

#### `entityHandling=false`

会影响：

- `attack @n`
- `interact @n`
- `ride`
- `fish`
- `entity list`
- `attack.autoAttack`
- `monitoring`
- recorder 实体数据范围

#### `terrainHandling=false`

会影响：

- `goto`
- `useblock`
- `cuseblock`
- `dig`
- `vault`
- `cplace`
- `blockBreakDetection`
- recorder 的 chunk / world snapshot 相关负担

### 15.3 不是 mineflayer 核心级关闭

需要明确：

- 这两个开关目前是 **功能级禁用**
- 不是 MCC 那种协议处理层彻底不维护实体/地形状态

所以节省的是：

- pathfinder
- feature 逻辑
- scan / interval
- recorder 额外处理

而不是彻底消除底层内存占用。

---

## 16. HTTP API 与面板关系

`MULTIBOT` 本身只负责后端。

前端面板 `MULTIBOT_PANEL` 只是它的客户端。

两者之间通过：

- HTTP API
- SSE

连接。

### 16.1 `HttpApiServer`

它是一个轻量原生 `http` 服务器，负责：

- Bearer Token 鉴权
- CORS
- bot 控制 API
- 实例管理 API
- SSE 订阅入口

### 16.2 为什么不用更重的 Web 框架

当前项目选择原生 `http` 的原因更偏现实：

- 依赖少
- 便于控制协议和返回结构
- 当前接口规模还可控

### 16.3 安全边界

当前内置的是：

- token 鉴权

它没有内建：

- TLS
- 反向代理
- 限流

因此公网暴露通常需要：

- Nginx / Caddy 等反代
- HTTPS
- 额外访问控制

---

## 17. 测试策略

当前测试主要使用 Node 原生 `node:test`。

### 17.1 测试分布

后端测试集中在：

- `MULTIBOT/test/*.test.js`

覆盖范围已经比较完整，包括：

- `BotRuntime`
- `BotManager`
- `CommandDispatcher`
- `HttpApiServer`
- `InstanceService`
- `ActivityLogFeature`
- `AggregateLogService`
- `RecorderFeature`
- `authCacheFactory`
- 各主要 feature

### 17.2 测试风格

测试总体偏向：

- 小模块行为测试
- 运行时装配验证
- 回归保护

这很适合当前项目的阶段，因为：

- 功能演进点多
- 行为兼容要求高
- 单次改动通常希望“只动一小块”

---

## 18. 当前设计取舍与已知边界

### 18.1 为什么复用的旧逻辑采用复制而非直接引用

原因有三类：

1. **隔离**
   - 防止 MULTIBOT 与外部工程相互污染
2. **可维护**
   - 复制进来的代码可以独立重构
3. **测试**
   - `MULTIBOT/test` 可以直接覆盖这份代码

### 18.2 为什么实例更新用“重建 runtime”

因为当前项目的重点是稳定运行，而不是在线热切换所有细节。

重建 runtime 的代价可以接受，但它显著降低了：

- feature 内部状态错乱
- 半热更新残留 timer
- 配置前后语义不一致

### 18.3 为什么能力开关只做到功能层

因为真正去改 mineflayer 的核心实体/区块维护，会把当前项目复杂度拉高很多：

- 协议兼容面更大
- 回归风险更高
- 测试成本更高

在现阶段，功能层和可选 recorder 适配层收缩已经更符合实际收益。

### 18.4 为什么保留大量旧语义

因为这个项目的核心价值之一就是：

- 让已有挂机脚本和控制习惯尽量平滑迁入新环境

所以某些地方即便从“纯架构设计”看不够优雅，也会优先保留旧行为。

---

## 19. 适合后续扩展的点

如果后续继续迭代，当前最自然的扩展方向通常有：

### 19.1 新命令接入

做法：

- 先在 `CommandDispatcher` 增加入口
- 再落到对应 feature
- 补充测试
- 最后更新 README

### 19.2 新共享服务

适合放在：

- `src/control`
- `src/logging`
- `src/session`

例如：

- 新的聚合服务
- 新的状态采样器
- 新的跨 bot 协调器

### 19.3 更深的 recorder 优化

适合放在 `RecorderFeature`；本地录制器实现位于被 Git 忽略的 `flashback-recorder/` 时，应继续保持为本地可选模块，不反向依赖外部旧实现，也不加入公开仓库。

### 19.4 更彻底的轻量化

如果后面确实要进一步压低实体/地形开销，下一步才可能考虑：

- 更深的 mineflayer 插件级裁剪
- 更细粒度的监听裁剪
- 更强的 recorder packet filter

而不是立刻进入协议层大改。

---

## 20. 一句话总结

`MULTIBOT` 当前的实现本质上是：

> 用一个可测试、可重建、可通过 HTTP/SSE/面板统一控制的多 runtime 容器，承载挂机、控制与录制能力，并在认证缓存、实例管理、日志观测、录制器和能力开关上做了适合当前阶段的工程化包装。

如果只记住三件事，建议记住这三条：

- **配置更新的真正生效路径是实例同步，而不只是普通 restart**
- **每个 bot 的核心执行单元是 `BotRuntime + Feature` 组合**
- **这个项目优先追求稳定兼容和模块化演进，不是一次性做成全新框架**

---

## 21. 断线随机重连（`restartJitterMs`）

这一轮没有引入全局连接队列，当前仍然是“每个 `BotRuntime` 独立决定是否重连、何时重连”的模型。

### 21.1 配置来源

推荐把随机打散配置写在：

- `MULTIBOT/BOTS/<serverDir>/server.json`

示例：

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
  "restartJitterMs": 120000
}
```

分级字段说明：

- `restartDelayScheduleMs`：可选的分级基础延迟数组，毫秒，允许值为 `0`；缺省表示未启用分级策略。
- `restartDelayScheduleRepeatLast`：`true`（默认）表示数组耗尽后重复最后一级；`false` 表示耗尽后停止自动重连。
- 这两个字段只从 `server.json` 顶层读取，Bot 配置不能覆盖；旧的 `restartOnDisconnect`、`restartDelayMs`、`restartJitterMs` 保持原有合并优先级，`connection.restartJitterMs` 同样参与解析。

### 21.2 延迟计算

`RestartPolicy` 现在把重连计划拆成三部分：

- `baseDelayMs`
- `jitterMs`
- `totalDelayMs`

未配置分级数组时，实际公式为：

- `totalDelayMs = restartDelayMs + random(0..restartJitterMs)`

其中：

- `restartJitterMs` 缺省为 `120000`
- `restartDelayMs` 缺省为 `60000`

配置分级数组时，`RestartPolicy` 按 `BotRuntime` 传入的 `attempt` 选择数组项：

- `attempt=0` 使用数组第一项，`attempt=1` 使用第二项，依此类推。
- 每一级实际延迟 = 当前级基础延迟 + `random(0..restartJitterMs)`。
- `repeatLast=true` 时数组耗尽后重复最后一项；`repeatLast=false` 时返回 `exhausted=true`，由 `BotRuntime` 进入耗尽停止状态。

`RestartPolicy` 是纯计算模块：它不保存尝试次数，只接收 `reason`、`attempt`、`overrideDelayMs`、`useReconnectPolicy`，返回 `baseDelayMs`、`jitterMs`、`totalDelayMs`、`scheduleConfigured`、`scheduleIndex`、`exhausted`。

显式认证重试（`invalid_session_retry`、`openauth_retryable_error`、`retryable_error`）携带 `overrideDelayMs`，使用精确延迟、`jitterMs=0`，不访问分级数组，也不消耗分级次数。

### 21.3 作用范围

重连策略统一作用于两类断开消息：

- 生效：`handleEnd()` 进入的普通 `disconnect`
- 生效：ViaProxy 后端不可达（`backend_unavailable`）
- 条件生效：至少成功 `spawn` 一次后，`scheduled_restart` 连接未收到 OpenAuth 请求（`openauth_request_missing`）
- 不生效：后端启动时的 `autoStart`
- 不生效：`invalid_session_retry`
- 不生效：`retryable_error`
- 不生效：手动 `restart`

ViaProxy 后端不可达消息（`Could not connect to the backend server!`、`An error occurred while connecting to the backend server: ...`）在首个 OpenAuth 请求前到达时，会被统一拆盒、去染色后按长文本片段包含匹配识别为 `backend_unavailable`，从而避免被误判为 `OPENAUTH_REQUEST_MISSING` 永久停止；识别后与普通断线共用同一套重连延迟策略。

OpenAuth 客户端会在有效 `oam:join` 解码并校验后、发起 Mojang Join 前同步通知运行时清除看门狗，因此 Mojang 响应耗时不会再被误判为请求缺失。首次或手动启动的 `OPENAUTH_REQUEST_MISSING` 仍按永久失败停止；只有曾成功上线且当前由 `scheduled_restart` 发起的连接会将其转为普通重连原因。`restartOnDisconnect: false`、分级数组耗尽、`PROXY_NOT_LOOPBACK` 及其他配置安全错误仍会停止，不允许直连回退。

运行时还会在 `minecraft-protocol` 的 `player_chat` 验签监听器之前安装连接级兼容保护。仅当数据包同时缺少 `signature` 和 `unsignedChatContent` 时，保护器才按当前协议生成 JSON 或 NBT 未签名内容；正常签名包和已有未签名标记的包保持不变。这样可兼容代理转换出的未签名私聊，防止 `crypto.verify(..., undefined)` 抛错后中断后续 keepalive 收包。

### 21.4 运行时状态

`BotRuntime.getRestartState()` 现在除了原有字段外，还会暴露：

- `disconnectJitterMs`
- `pendingRestartDelayMs`
- `pendingRestartScheduledAt`
- `restartAttempt`
- `restartScheduleLength`
- `restartScheduleRepeatLast`
- `restartScheduleExhausted`

这让 summary/detail 状态既能看到“当前配置允许多大随机抖动”，也能看到“这一次已经选中的实际延迟和预计触发时间”。

计数规则：

- 只有同时满足“使用普通重连策略”和“实际配置了分级数组”时才消耗一次 `restartAttempt`。
- 成功 `spawn`、手动停止、手动启动（`start({ source: 'manual' })`）后清零；重连计时器触发的 `start({ source: 'scheduled_restart' })` 不清零。
- 未配置分级数组时 `restartAttempt=0`、`restartScheduleLength=0`、`restartScheduleExhausted=false`。

断线消息分类绑定当前连接代次（`connectionEpoch`），旧连接迟到的 `kicked` / `disconnect` 事件不会污染新连接状态；同一连接内按 `backend_unavailable > ordinary_disconnect > unknown` 优先级合并，只升不降。

### 21.5 KeepAlive 本地超时

`checkTimeoutInterval` 是连接级 runtime 字段，默认 `30000`。

它的实际生效链路是：

1. `loadMasterConfig()` 从 `defaults` / `server.json` / `connection` / bot 配置中解析并归一化。
2. `BotRuntime.createMineflayerOptions()` 将它放入 `mineflayer.createBot()` options。
3. `mineflayer` 的 loader 会把 options 原样传给 `minecraft-protocol.createClient(options)`。
4. `minecraft-protocol/src/client/keepalive.js` 使用 `options.checkTimeoutInterval` 设置本地 keepalive 等待超时。

因此该字段不是“只写配置”，而是会实际影响 `client timed out after ... milliseconds` 这类本地超时判断。

边界：

- 可以减少服务端短暂卡顿时客户端本地误判超时。
- 不能保证解决 `read ECONNRESET`，因为这通常是服务端、代理或网络链路主动重置连接。

### 21.6 日志输出

当 runtime 进入挂起重连时，日志会统一输出：

- `reason`
- `baseDelayMs`
- `jitterMs`
- `totalDelayMs`

例如常规断线可能看到：

```text
[BOT] scheduled restart reason=disconnect baseDelayMs=60000 jitterMs=34567 totalDelayMs=94567
```

启用分级数组时，日志会附带当前分级次数：

```text
[BOT] scheduled restart reason=backend_unavailable attempt=2 baseDelayMs=300000 jitterMs=48123 totalDelayMs=348123
```

未配置分级数组时不输出 `attempt`，不会伪装成正在使用分级策略。数组耗尽并停止时记录：

```text
[BOT] reconnect attempts exhausted reason=backend_unavailable attempts=7
```

而认证快速重试这类非断线 reason 则会保持：

```text
[BOT] scheduled restart reason=invalid_session_retry baseDelayMs=1000 jitterMs=0 totalDelayMs=1000
```

---

## 22. 单实例瘦终端连接器

这一轮在后端之上补了一层“单 bot 远程控制台”能力，用来把旧单实例面板进程退化成一个只负责连后端的轻量终端。

### 22.1 目标边界

连接器本身：

- 不登录 Minecraft
- 不运行 `mineflayer`
- 不自己维护 bot 状态机
- 只负责连接后端、打印日志、转发控制台输入

因此真正的 bot 生命周期仍然完全在 `MULTIBOT` 后端里，由 `BotManager` / `BotRuntime` 负责。

### 22.2 后端配置来源

后端新增主配置：

```json
{
  "consoleConnector": {
    "historyLimit": 300
  }
}
```

它由 `loadMasterConfig()` 归一化后挂到：

- `masterConfig.consoleConnector.historyLimit`

用途只有一个：

- 控制 `GET /api/bots/:id/console-stream` 首次 `bootstrap.logs` 的历史条数上限

为了避免“配置了 800 条历史，但 logger ring buffer 只有 500 条”这种错配，`BotManager.createRuntime()` 会把 logger buffer 扩成：

- `max(500, historyLimit)`

### 22.3 bot 级 SSE：`GET /api/bots/:id/console-stream`

原先 `EventStream` 只有全局广播视角；这一轮扩展后，它同时支持：

- client 级事件过滤
- 连接时 bootstrap 事件
- client 级 heartbeat
- 后端进程级 session 信息

`HttpApiServer` 新增：

- `GET /api/bots/:id/console-stream`

这个接口在鉴权通过后会：

1. 读取指定 bot 的 detail 与近期日志
2. 读取 `eventStream.getSessionInfo()`
3. 注册一个只接收该 bot `log` / `botStatus` 的 SSE client
4. 先发一条 `bootstrap`
5. 之后持续推送该 bot 的实时日志和状态

`bootstrap` 里包含：

- `backendSessionId`
- `backendStartedAt`
- `historyLimit`
- `bot`
- `logs`

这样连接器一接上来就能立即补齐“最近这段历史发生了什么”，而不用等后续实时流慢慢刷出来。

### 22.4 为什么要有 `backendSessionId`

连接器会把最近一次打印过历史日志的后端会话 ID 记下来。

语义是：

- **首次连接**
  - 打印历史日志
- **同一个后端进程里的短暂断线重连**
  - 不重复打印历史日志
- **后端整个进程重启后**
  - `backendSessionId` 变化
  - 重新打印新的历史日志

这能避免“网络抖一下就把最近 300 条又刷一遍”的噪声，同时保留“后端重启后重新补历史”的可观测性。

### 22.5 连接器状态机

`ConsoleConnectorClient` 当前内部状态是：

- `connecting`
- `online`
- `offline`
- `stopped`

核心行为：

- `start()`
  - 建立 bot 级 SSE
- 收到 `bootstrap`
  - 切到 `online`
  - 首次或后端会话变化时打印历史日志
- SSE 中断
  - 切到 `offline`
  - 只打印一次“实例已离线”
  - 后台继续重连
- `stop()`
  - 清理重连 timer
  - 关闭当前 SSE 连接
  - 切到 `stopped`

### 22.6 控制台输入策略

连接器本地只特殊处理一个命令：

- `/start`

在线时：

- `/start`
  - 调 `POST /api/bots/:id/start`
- 其他输入
  - 调 `POST /api/bots/:id/command`
  - body 固定走 `input` 模式

离线时：

- `/start`
  - 先立即尝试前台重连 SSE
  - 连上后再调 `start`
  - 连不上就直接报错，不缓存
- 其他输入
  - 直接提示“后端未连接，无法发送控制台输入”

### 22.7 为什么仍保留全局 `GET /api/events`

这轮没有用 bot 级 SSE 去替换全局 SSE，而是并存：

- `GET /api/events`
  - 给原网页面板 / 全局观察用
- `GET /api/bots/:id/console-stream`
  - 给单实例瘦终端连接器用

这样做的好处是：

- 不破坏既有面板协议
- 连接器拿到的是更适合单 bot 终端的 bootstrap + filtered stream
- 全局观察流仍然保持现有简单模型
