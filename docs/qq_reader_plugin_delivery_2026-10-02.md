> **最新状态（2026-10-04）：Windows 原生前后端与 Java 桌宠已更新重启，QQ 接入切换为当前客户端的 1330 开头、尾号 8336 账号；当前 Reader 已连接且无错误。新版消息历史要求会话白名单，导入同步尚未配置，不能将连接成功等同于消息已入库或可供 Agent 查询。以下 2026-10-02 账号及接收记录为历史测试。**

> **最新实测状态（2026-10-02）：已使用 SnowLuma 接入原有 Windows QQ 主进程，核对目标账号尾号 9784，Reader 在线并已收到测试标记消息。下面早期 NapCat Shell 的停用与误接记录保留用于追溯；当前接入方式是 SnowLuma，未启动独立 QQ 登录会话。后端同步仍未配置。**

# QQ 只读接入：可选插件原型交付

日期：2026-10-02。范围：Windows 前端 Python Reader、前端 SQLite、状态页面与 Java 桌宠状态桥接、协议提案及隔离测试。首次交付为默认关闭的原型；随后按用户要求完成了真实 Windows 安装与连接，最新状态见第 7 节。后端代码未修改。

## 1. 可行性与边界

链路可行：Windows Reader 主动连接 Windows 本机 NapCat，消息先落前端本地库，再向经 Windows localhost 可访问的后端同步。WSL 默认 NAT 下不能把 WSL 的 localhost 当作 Windows localhost；镜像网络与默认 NAT 的连接行为不同。参考 [Microsoft WSL 网络说明](https://learn.microsoft.com/en-us/windows/wsl/networking)。

OneBot 标准描述 `/event` 为事件连接、`/api` 为 API 连接、`/` 同时承载两者。**当前检查到的 NapCat 源码仍为事件连接注册 action 消息处理器，不能依靠 `/event` 强制只读。**本插件从不发送应用消息/action，仅使用 WebSocket 控制帧进行连接健康检查；默认 `/event`，不自动回退到 `/`。真实安装版本必须另行核验。[OneBot 协议](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)、[NapCat WebSocket 服务源码](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/network/websocket-server.ts)。

NapCat WebUI 的文档默认 host 为 `0.0.0.0`，安装时要改成 `127.0.0.1`；OneBot WS 也只监听本机，并设置非空 Token。[NapCat 配置说明](https://napneko.github.io/config/basic)。安装器和登录方式的差异可能影响原 QQ 客户端共存，本次没有验证；人工使用客户端仍是实际验收项目。[NapCat Shell 启动说明](https://napneko.github.io/guide/boot/Shell)。

## 2. 已完成 TODO

- [x] 默认关闭，关闭时不创建 QQ 数据库、不连接网络、不启动 Reader 后台任务。
- [x] 仅 Windows 原生进程可启用；配置失败不阻断主前端启动。
- [x] WebSocket 仅接受本机地址，不允许 URL 内凭据、query Token、自动重定向或环境代理。
- [x] Authorization Bearer 鉴权；64 KiB 事件上限、有限接收队列、健康检测与重连退避。
- [x] 只接收私聊/群聊 `post_type=message`；忽略通知、请求及 `message_sent`。
- [x] 只提取文字；群发言者优先群名片，回退昵称；不下载媒体，不保存纯媒体消息。
- [x] SQLite 以 `(self_id, message_id)` 去重；同一消息重复接收不覆盖首次正文、不重置已同步标记。
- [x] 正文与未同步状态原子落库；后端离线保留待同步消息，重启后仍可重试。
- [x] 原始事件默认不保存；前端 QQ 数据目录、私有配置忽略 Git。
- [x] 独立同步密钥；仅显式确认的本批消息标为已同步，HTTP 200 本身不算确认。
- [x] 前端状态接口限制本机访问，校验 Host/Origin，只返回白名单字段与错误码。
- [x] 设置面板折叠展示状态，按需刷新；浏览器和 Java 桌宠读取同一个前端状态接口。
- [x] Java 请求使用 HTTP/1.1，只 GET 固定状态路径，不传 QQ 凭据。
- [x] 隔离测试：模拟事件、临时 SQLite、模拟后端、真实本机测试 WebSocket、浏览器与 JavaFX 桥接。

## 3. 文件与运行方式

| 文件 | 用途 |
| --- | --- |
| `app/plugins/qq_reader.py` | Reader、标准化、SQLite、同步队列 |
| `app/plugins/lifecycle.py`、`app/main.py` | 可选插件启动、停止和故障隔离 |
| `app/api/routes/plugins.py` | `GET /plugins/qq-reader/status` |
| `app/web/pet/qq-reader.js`、`.css`、`chat.html` | 状态面板 |
| `PetChatBridge.java`、`PetControlWindow.java` | Java 桌宠状态传输 |
| `.env.qq-reader.example`、`requirements-qq-reader.txt` | 私有配置模板、可选依赖 |
| `tests/test_qq_reader.py`、`test_qq_plugin_status.py` | Python 隔离测试 |
| `tests/frontend_qq_reader_smoke.cjs`、`PetMemoryBridgeCheck.java` | UI/Java 桥接验证 |

将 `.env.qq-reader.example` 的配置项**合并**进项目已有私有 `.env`，不要覆盖已有设置。现有 `run-native-local.ps1` 会加载 `.env` 到 Windows Python 子进程；直接运行 uvicorn 时，应先在该进程环境中设置 QQ 配置。`.env.qq-reader` 本身不会自动加载。

```dotenv
QQ_READER_ENABLED=false
QQ_WS_URL=ws://127.0.0.1:3001/event
QQ_WS_TOKEN=
QQ_EXPECTED_SELF_ID=
QQ_DB_PATH=data/qq/reader.db
QQ_STORE_RAW_EVENT=false
QQ_SYNC_URL=
QQ_SYNC_TOKEN=
```

确认实际 NapCat 版本、监听地址、事件路径及 Token 后才设为 `true`。同步接口尚未落地，`QQ_SYNC_URL` 保持空白；Reader 可以先本地落库，状态显示“未配置后端同步”。数据库放在 Windows 本地磁盘，不能放 UNC、WSL 共享目录，也不能两侧直接共用 SQLite。数据库含聊天文字，需按个人敏感数据管理；当前不做超时清理。

可选依赖安装与测试命令（Windows PowerShell，项目根目录）：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-qq-reader.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_qq*.py' -v
```

本次环境已经有 websockets 16.0/httpx 0.28.1，没有执行依赖安装。测试不使用真实 QQ 凭据，只绑定随机本机端口、使用临时数据库。

## 4. 后端同步协议 V1：待确认提案

**当前后端没有实现该接口。下面不是现有 API 合同；应由后端负责人确认后实现。**

- `POST /integrations/qq/messages/import`，仅本机访问，独立 Reader 导入密钥。
- 该密钥只授权导入，不授权 Agent API、消息查询或其他管理操作；不能与 NapCat Token 相同。
- 每批最多 100 条；整体请求/字段需有界；后端验证完整字段及账号/会话许可范围。
- 后端在自己的 SQLite 中按 `(self_id,message_id)` 幂等写入；重复已存在的消息也返回确认。
- 接收者仅在事务提交后确认；无权限/无效项不能确认，不能将整批默认视为成功。
- 只收标准化记录，不接收原始 OneBot 事件，不保存 NapCat URL/Token。
- Windows 使用 `http://127.0.0.1:8765/...` 或经验证的 localhost 转发。localhost 不通时先修复本机转发，不放宽成局域网 NapCat 地址。

请求例子（全部为合成数据；两个时间字段都是 Unix 秒）：

```json
{
  "schema_version": 1,
  "messages": [{
    "schema_version": 1,
    "self_id": "test-account",
    "message_id": "test-message",
    "conversation_type": "group",
    "conversation_id": "test-group",
    "sender_id": "test-sender",
    "display_name": "测试群名片",
    "text": "模拟消息",
    "sent_at": 1790906400,
    "received_at": 1790906401
  }]
}
```

响应例子：

```json
{"acknowledged":[{"self_id":"test-account","message_id":"test-message"}]}
```

不在本批次中的确认项会被 Reader 忽略；未确认消息保持待同步。无确认列表、非法响应、鉴权失败、超时及离线不会删除本机消息。原始事件即使本地显式启用保存，也不加入同步请求。

## 5. 后续接入验收 TODO

- [ ] 后端确认导入接口、独立密钥管理、请求上限、账号/会话权限过滤与事务确认语义。
- [ ] 后端实现 `qq_recent_messages`、`qq_search_messages`、`qq_get_conversation`：`read_only=True`、数量/时间范围有界、按权限过滤，无发送/撤回/管理工具。
- [x] 在真实 Windows 安装 NapCat Shell，记录版本，验证 `/event` 实际行为与 Authorization Token。
- [x] 检查 WebSocket/WebUI 仅本机监听。
- [ ] 确认原 QQ 客户端可以继续人工收发。
- [ ] 私聊与群聊收到消息后约 1–2 秒进入前端 SQLite，并由后端只读工具检索；记录实际延迟。
- [ ] 验证重复事件、Reader 重启、后端离线再恢复、部分确认、鉴权错误及端口被占用。
- [ ] 验证 Agent 无法访问 NapCat 凭据、无法读超出授权范围的会话。

断线重连只恢复连接，不代表补回 NapCat 断线期间未收到的历史消息。当前不能承诺真实 QQ 完整补回或端到端 1–2 秒延迟。

## 6. 测试结果

| 验证 | 结果 |
| --- | --- |
| Windows Python 3.12：`unittest discover -s tests -p 'test_qq*.py' -v` | 15/15 通过，无跳过 |
| Python 插件、状态路由、`app/main.py` compileall | 通过 |
| Windows Chrome：`tests/frontend_qq_reader_smoke.cjs` | 通过；5 次模拟状态请求，未连接其他接口或 WebSocket |
| Windows Gradle：`compileJava --offline` | 通过 |
| JavaFX：`verifyPetMemoryBridge --offline` | 通过；固定状态路由、GET、无 Authorization、HTTP/1.1 及回调 |
| Git 差异空白检查（保留仓库既有 CRLF） | 本次相关文件通过 |

Python 使用临时数据库，并实际连接了本机模拟 WebSocket 服务：验证超限断开、重连入库、服务端未收到应用帧、重定向时不转发 Token。同步测试运行真实队列循环，模拟错误确认、空确认、部分确认、后端离线后恢复；不是调用真实后端。

浏览器测试使用隔离的状态组件页面和项目现有样式，验证 430×680 面板布局、折叠不请求、固定错误提示、凭据/正文不渲染以及 Java 回调匹配；不等同于完整工作台回归。截图位于忽略目录 `.runtime/qq-smoke/qq-reader-430x680.png`。

以上是首次原型阶段的验证结果；后续真实安装记录如下。原客户端人工使用与端到端延迟尚未完整验收。

## 7. 实际安装与连接记录

**最新状态：用户指出缓存账号并非目标账号，本次误接会话已停止，Reader 已停用，自动登录账号已清空。此前接收的数据已隔离保留于本机 `.runtime/qq-quarantine/`，不再作为当前消息库。等待用户确认目标账号或目标客户端后再连接。以下是此前安装测试记录，不代表正确目标账号已经接入。**

按用户“安装并尝试连接”的要求，已完成：

- 下载 [官方 NapCat Shell v4.18.28](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.28)，安装在 `D:\agent-bot-frontend\.runtime\napcat\v4.18.28`，未替换现有 QQ 安装文件。
- ZIP SHA-256 核对通过：`bcdd8bdb9e44bd0cf6a90908e572141787fd9e98cb8d8eecc5adf25bbdcabb94`。
- Windows 虚拟环境可选依赖安装检查通过，已存在 websockets 16.0，无依赖升级。
- 私有 `.env` 中启用 QQ Reader，生成非空 OneBot Token，与 NapCat 配置匹配；原始事件保存仍为关闭。
- 重载 Windows 前端服务，`GET http://127.0.0.1:8000/plugins/qq-reader/status` 返回 `enabled=true`、`connection_state=connected`、`last_error=null`。
- NapCat 是独立 QQ 会话，初次启动等待扫码；随后通过它自带的本机快速登录接口复用了唯一的已有账号，**无需额外扫码，已登录成功**。已保存 NapCat 的快速登录账号设置。
- 真实 `/event` 连接成功，首次检查时前端 SQLite 已有 **3 条真实消息**、3 条待同步记录；仅检查计数，没有读取或输出正文。
- 实际监听核验：WebSocket `127.0.0.1:3001`、WebUI `127.0.0.1:6099`，没有开放到局域网。
- 实际鉴权核验：本版本无 Token 时先完成 WebSocket 握手，再返回 `retcode=1403` 并关闭；未收到消息事件。这不是 HTTP 401，不能仅凭握手成功判断授权成功。
- NapCat 文件日志、控制台消息日志已关闭；QQ 登录二维码属于本机临时运行文件。原 QQ 客户端进程仍在，本次没有终止它；实际人工收发与会话共存仍需用户确认。

### 当前保留的边界

后端健康接口从 Windows 可访问，但 OpenAPI 中尚无 QQ 导入路由。`QQ_SYNC_URL` 留空，状态为 `not_configured`；消息留在前端本地 SQLite，**尚未同步至后端，Agent 尚不能查询这些消息**。

这次没有发送任何 OneBot action，也没有自动向好友或群发送测试消息。真实重复事件、断线期间历史完整性和端到端 1–2 秒延迟均不据此宣称通过。

### 下次启动与检查

前端服务仍运行，但 QQ Reader 目前停用。Windows PowerShell 中可检查状态（不显示聊天正文或凭据）：

```powershell
Set-Location D:\agent-bot-frontend
.\.venv\Scripts\python.exe .runtime\qq-setup\check.py
```

后续启动前必须先确认目标账号和接入方式；不能凭“缓存列表只有一个账号”判断目标账号。先前保存的快速登录选择已清空，辅助脚本也已改成必须显式指定并核对目标账号。没有添加 Windows 开机自启动项。

停用 Reader：私有 `.env` 中设置 `QQ_READER_ENABLED=false` 并重启前端；已有数据库保留。启用状态面板位于工作台“设置 → QQ 只读接入”。

### 误接账号后的防护与当前客户端方式

已新增 `QQ_EXPECTED_SELF_ID` 账号绑定；本环境启用前必须先确认并填写目标账号。配置后，Reader 检查收到的事件账号，发现不匹配即关闭连接、停止接收、不入库，状态面板显示账号不一致；同步批次也只包含指定账号。安装辅助脚本现在要求显式账号参数，不再自动启用未绑定账号。账号校验不向浏览器暴露账号标识。

追加验证：Windows Python QQ 测试 **17/17 通过**，包括错误账号生命周期事件直接停止且零入库、同步队列账号过滤。没有为验证重新连接真实账号。

用户要求沿用当前可视 QQ 客户端、避免独立 Shell 会话。对应候选为 NapCat Framework/LiteLoader，而不是继续启动 Shell。尚未在现有 QQ 安装中加载框架；官方指出 QQ 9.9.19 之后 LiteLoader 维护不足，不再推荐相关安装方式，当前环境的 QQ 版本在此范围内。不能将“存在 Framework 插件包”当成“已验证可直接附加正在运行的 QQ”。[官方 Framework 说明](https://napneko.github.io/guide/boot/Framework)。

### 客户端选择复核

按用户要求检查了实际运行的 QQ 进程、参数、安装版本清单及本次启动脚本：

- 用户可视 QQ 主进程为 PID 26224，程序路径 `D:\Softwares\QQ.exe`；本次 NapCat 启动脚本选择的也是此路径，并没有证据表明使用了另一套 QQ 安装。
- 可视 QQ renderer 的 `--app-path` 指向 `D:\Softwares\versions\9.9.20-37625\resources\app`；安装版本清单与 NapCat 私有启动日志均确认 9.9.20-37625。注册表和根目录引导 exe 的旧版本号不是实际运行版本，先前报告版本的依据不准确。
- 桌面 Electron 配置目录是 `%APPDATA%\QQ`。NapCat 记录的原生账号数据位于 `D:\SoftwareData\QQData\Tencent Files`，其中目标账号与先前误选账号的数据目录均存在。Electron 配置目录与原生账号目录是两种用途，不能仅因路径不同就判定为另一套客户端。
- 已检查安装包源码：`GetQuickLoginList` 使用的列表来自 `LocalLoginInfoList.filter(user => user.isQuickLogin)`，不是当前桌面客户端的已登录账号列表。启动记录中出现过目标账号，但我只依据过滤后的唯一候选自动登录，造成账号误选。
- Shell 对同一个 QQ 程序创建新的内核登录会话，并未接入已运行的可视主进程。因此根因是**接入方式与账号选择错误**，不是 QQ.exe 安装路径选错。
- 私有配置已绑定用户确认的目标账号（尾号 9784），但 Reader 继续停用；独立会话启动辅助脚本已禁用，没有为复核启动新 QQ、切换账号或修改用户 QQ 文件。

复核只读取进程、路径、版本与目录元数据，没有读取聊天数据库或解密登录凭据。未从 GUI 直接读取当前账号；当前登录账号以用户的确认作为依据。


## SnowLuma 现有客户端接入实测

### 安装与手动接入

- 官方发布包：[v1.14.20 Windows x64](https://github.com/SnowLuma/SnowLuma/releases/tag/v1.14.20)，安装目录 `D:\agent-bot-frontend\.runtime\snowluma\v1.14.20`。
- SHA-256 核对 GitHub 发布记录通过：`0ca7bd4a4541cc896ade2a4344ff1901b45eeb4392ab356a71836feb6b311640`。
- 用户明确要求继续测试后，完成首次 EULA/隐私确认；初始管理密码已更换为随机密码，存于私有运行目录，不在交付文档、浏览器业务页面或日志输出中公开。
- 关闭自动注入，设置 `SNOWLUMA_HOOK_AUTOLOAD=0`；关闭遥测 `SNOWLUMA_TELEMETRY=0`。手动加载原有 QQ 主进程 PID 26224，路径 `D:\Softwares\QQ.exe`，实际版本 9.9.20-37625；此主进程始终保留，没有另开登录会话或要求重新扫码。
- 仅启用 OneBot WebSocket：`127.0.0.1:3001/event`，角色 `Event`，非空独立 Token；关闭 HTTP API、反向 WS 和外部事件推送。WebUI 仅 `127.0.0.1:5099`。未配置 QQ 发送工具或调用 OneBot action。

### 发现并修复的实际问题

原包登录探测 `CONNECTION_TIMEOUT_MS=500`，本机 Node 对 QQ `4301` 端口的 HTTPS 查询实测约 1943 毫秒。因此内部 pipe 已连接，但账号一直无法识别，OneBot 事件接口没有启动。

只调整 SnowLuma 本地发布包中的两个探测时间：单次连接 500 → 3000 毫秒，总探测 5000 → 15000 毫秒。原文件备份为 `index.mjs.original`。重启 SnowLuma 后即识别目标账号，状态变为 `online`；没有修改 QQ 安装文件或重启 QQ。该修改属于本机兼容修补，升级 SnowLuma 时需要重新检查官方是否已修复；不是前端源代码的修改。

### 验证结果与范围

- SnowLuma 识别到 1 个账号，匹配用户指定账号尾号 9784。
- 前端 `/plugins/qq-reader/status`：`enabled=true`、`connection_state=connected`、`last_error=null`。
- 当前前端 SQLite 检查时 1 条消息，均为指定账号，原始事件为 0 条，待同步 1 条。包含 `test message for lka` 的私聊测试标记匹配 1 条；没有输出其他聊天正文、联系人信息或凭据。仅标记匹配不能证明就是先前 16:03 那条消息，也不据此宣称断线历史完整补回或 1–2 秒延迟达标。
- 无 Token 连接被 HTTP 401 拒绝。相关监听均核验为本机地址。
- Windows Python 针对性验证：`python -m unittest discover -s tests -p 'test_qq*.py' -v`，17/17 通过，覆盖账号不匹配、去重、多账号隔离、超大事件、自动重连和离线同步队列。
- 后端 QQ 同步 API 尚未接入，`sync_state=not_configured`；当前只实现并验证 Windows QQ → SnowLuma → Reader → 前端本地 SQLite，不能宣称 Agent 已可查询。

### 当前运行与回退

SnowLuma 与 Reader 当前保留运行，未添加开机自启。Reader 私有配置启用且绑定指定账号；之前误接账号数据库继续隔离，不并入当前消息库。

检查状态：在 Windows 运行 `.venv\Scripts\python.exe .runtime\snowluma\v1.14.20\check.py`，只输出状态、计数和测试标记匹配。

停用接收：设置 `.env` 的 `QQ_READER_ENABLED=false`，重启前端。需要卸载 hook 时应使用 SnowLuma 手动卸载接口；不要使用批量结束 QQ 的脚本。SnowLuma 改动前的私有 `.env` 备份为 `frontend-env-before-test.private`，其中包含其他敏感配置，回退时仅恢复 QQ 配置项，避免覆盖后续修改。

官方依据：[现有 Windows QQ 进程接入](https://snowluma.github.io/en/docs/guide/deploy/windows)、[事件通道配置](https://snowluma.github.io/en/docs/guide/configuration)。实测成功仅对应本机这一版本组合，不承诺未来 QQ 自动更新后仍兼容。


## 2026-10-04 更新重启与账号切换

- 用户明确要求改接当前登录的 1330 开头账号。通过当前 QQ 主进程所属的 4301 本机状态端口核验仅有一个匹配账号，尾号 8336；不再依赖缓存快速登录列表。
- 原 QQ 主进程 PID 9036 持续保留。SnowLuma 手动接入该进程，状态 `online`，账号匹配；自动注入和遥测仍关闭，QQ 没有重启或新增独立登录会话。
- Windows 后端从 WSL 当前工作树同步 25 个内容变化文件，全部 SHA-256 比对一致，包含消息历史模块与最新接口。更新前部署文件备份于前端 `.runtime/backend-refresh-20261004`。保留 Windows 本地数据库、配置、虚拟环境与目标独有文件，没有 Git 提交、远程拉取或依赖升级。
- 重启前按启动记录校验路径、PID、启动时间后停止原有前后端；重新启动 Windows 后端 8765、前端 8780，并重新构建启动 Java 桌宠。实际检查两端 `/health` 正常，后端最新消息历史接口已出现，前端工作台包含消息历史页面，桌宠指向当前端口。
- SnowLuma 仅监听本机 `5099` 管理接口和 `3001/event` 事件接口，角色 `Event`；新账号使用独立事件 Token。私有 `.env` 与目标账号配置已备份，旧账号数据库与旧配置保留，不自动迁移此前的隔离数据。
- 鉴权 WebSocket 生命周期事件的 `self_id` 与当前账号匹配；无 Token 返回 HTTP 401。只验证连接与身份，本轮没有发送 QQ 消息或宣称新消息入库。
- 重启发现 Reader 重连成功后仍显示历史 `websocket_error`。前端修复为收到新帧后清除旧传输错误，不清除账号不匹配等其他错误；新增持续连接恢复测试。两项旧合成接收测试补齐新版白名单许可，未放宽运行时权限。
- QQ 针对性测试 18/18 通过；实际状态为 `enabled=true`、`connection_state=connected`、`last_error=null`，`sync_state=not_configured`。

### 新版消息历史边界

当前导入同步 URL/Token 未配置，没有可用会话白名单。新版 Reader 会忽略未许可会话，不沿用旧版本的全量接收行为。后续需要配置独立导入鉴权，并由用户在“消息历史”中选择允许记录的私聊或群聊；是否开启模型分析需另外由用户决定。本次只按要求更新、重启并接入当前账号，不自动允许所有联系人或群。

工作台地址：`http://127.0.0.1:8780/desktop-pet/chat.html?backend=http%3A%2F%2F127.0.0.1%3A8765`。
