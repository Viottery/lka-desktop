# QQ 消息接口工程交付 · 2026-10-04

## 范围与完成清单

本次仅实现 `D:\agent-bot-frontend` 的 Windows Python 服务接口。没有修改 LKA 后端，没有加入 Agent 发消息工具，交付时没有启用生产发送配置；随后按用户明确指定的目标完成一条真实文字发送测试。现有 `qq_reader` 的只读接收、同步配置和权限保持独立。

- [x] SnowLuma HTTP 动作通信，独立于 `/event` 接收连接。
- [x] 私聊、群聊文字、图片、视频、表情包、普通 QQ 表情的标准化收发。
- [x] 群聊 `@`、回复引用；收藏表情包 ID 查询与发送。
- [x] SQLite 持久化、账号隔离、消息去重、游标查询和 SSE 实时接收。
- [x] 按会话授权接收/发送，默认均不允许。
- [x] 本机访问、同源检查、独立 API 鉴权、发送前核对登录账号。
- [x] 原始二进制上传、受限媒体缓存及下载；不接受任意路径或 URL 发送。
- [x] 幂等发送、持久化回执、超时/取消/重启后的“结果未知”处理。
- [x] Windows Python 模拟网关验收与旧接口定向回归。

真实 QQ 文字发送已按下文单次测试验证；图片、视频、表情包的真实发送及对方收到情况尚未实测。发送开关仍保持关闭。

## 结构

```text
SnowLuma /event :3001 → QQMessaging → 前端独立 SQLite → 查询 / SSE
本机调用方 → 鉴权 / 会话权限 / 幂等检查 → 账号核对 → SnowLuma HTTP :3002
本机二进制上传 → 前端媒体缓存 → image / video / sticker 消息段
```

实现文件：

- `app/plugins/qq_actions.py`：有界 OneBot HTTP 客户端。
- `app/plugins/qq_messaging.py`：配置、事件接收、SQLite、媒体、发送回执。
- `app/api/routes/qq_messaging.py`：本机 API。
- `app/plugins/lifecycle.py`、`app/main.py`、`app/api/routes/plugins.py`：插件启动和路由。
- `app/plugins/message_media.py`：增加可选的下载域名参数；旧 Reader 默认域名策略不变。
- `tests/test_qq_actions.py`、`tests/test_qq_messaging.py`：无真实 QQ 连接的测试。

不要让两个服务进程同时管理同一个 messaging.db。Windows Python 服务及 SnowLuma 应在同一 Windows 主机运行；发送文件路径由该服务生成。不要跨 Windows/WSL 共用 SQLite。

## 可选配置

完整示例见 `.env.qq-reader.example`。新增功能默认关闭：

```dotenv
QQ_MESSAGING_ENABLED=false
QQ_SEND_ENABLED=false
QQ_MESSAGING_API_TOKEN=
QQ_ACTION_URL=http://127.0.0.1:3002
QQ_ACTION_TOKEN=
QQ_ACTION_TIMEOUT_SECONDS=60
QQ_MESSAGING_DB_PATH=data/qq/messaging.db
QQ_MESSAGING_MEDIA_DIR=data/qq/messaging-media
QQ_MESSAGING_IMAGE_MAX_BYTES=20971520
QQ_MESSAGING_VIDEO_MAX_BYTES=209715200
QQ_MESSAGING_MEDIA_MAX_BYTES=2147483648
QQ_MESSAGING_MESSAGE_MAX=100000
```

接收复用 `QQ_WS_URL=ws://127.0.0.1:3001/event`、`QQ_WS_TOKEN`、`QQ_EXPECTED_SELF_ID`。只有 `/event` 路径被允许，接收连接不发送 OneBot action。

启用步骤：

1. 在 SnowLuma 增加仅监听 `127.0.0.1:3002` 的 HTTP 服务，并设置独立 Bearer Token；保留原来的 Event 服务。
2. 配置期望 QQ 账号、Event Token、Action Token。`QQ_MESSAGING_API_TOKEN` 使用另外生成的至少 32 字符随机密钥。
3. 设置 `QQ_MESSAGING_ENABLED=true`，重启前端 Windows Python 服务。
4. 调用会话权限接口，只开启所需联系人的接收权限。
5. 准备实际发送时，设置 `QQ_SEND_ENABLED=true`，重启服务，并开启目标会话的发送权限。

配置缺失或不合法时，该可选插件停止，主应用继续启动。插件未启用时，新增 API 返回 `503 messaging_disabled`。

不要将 SnowLuma Token 放进 JS、URL、localStorage 或日志。API Token 也不硬编码到网页资源；后续原生调用方应通过私有配置读取。若浏览器需要接入，应使用受控的本机凭据桥接，并采用请求头鉴权。

## API 合约

根路径：`http://127.0.0.1:8780/plugins/qq-messaging`，端口随前端服务配置。

所有请求必须包含 `Authorization: Bearer <QQ_MESSAGING_API_TOKEN>`。只接受本机客户端、本机 Host 和同源 Origin；禁止跨站请求。正常响应禁止缓存。JSON 写请求使用 `Content-Type: application/json`。

| 方法 / 路径 | 用途 |
| --- | --- |
| `GET /status` | 启用、连接、最近接收时间、稳定错误码；不输出账号凭据或正文 |
| `GET /capabilities` | 消息段类型、大小限制、发送开关、网关约束 |
| `GET /conversations/{private或group}/{QQ号或群号}` | 获取会话权限 |
| `PUT /conversations/{private或group}/{QQ号或群号}` | 显式设置接收和发送权限 |
| `GET /messages?conversation_type=private&conversation_id=…&after=0&limit=50` | 持久化游标查询，limit 1–100 |
| `GET /events?conversation_type=private&conversation_id=…&after=0` | SSE 消息流，每 0.5 秒检查本地增量 |
| `POST /media/{image或video或sticker}` | 请求体直接为文件字节，返回媒体 ID |
| `GET /media/{media_id}` | 鉴权下载上传文件或已缓存接收附件，支持文件响应 |
| `POST /messages/{seq}/media/{ordinal}/cache` | 显式缓存收到的图片/视频/表情包 |
| `GET /stickers?limit=48` | 获取登录账号的收藏表情包 ID，最多 100 |
| `POST /messages/send` | 发送结构化消息，必须提供 Idempotency-Key |
| `GET /sends/{key}` | 查询持久化发送回执 |

### 会话权限

```json
{"receive_enabled": true, "send_enabled": false}
```

两项都必须是布尔值。未设置的会话默认拒绝。关闭接收会保留既有本地数据，但禁止读取该会话、继续下载及访问其已缓存附件。权限变更与发送使用同一把锁；已在网关执行的发送无法撤回。

### 发送

`Idempotency-Key` 为调用方生成的 8–128 字符标识，仅允许字母、数字、下划线和短横线。推荐随机 UUID。同一逻辑消息始终复用同一个键。

```json
{
  "conversation_type": "private",
  "conversation_id": "目标QQ号",
  "segments": [{"type": "text", "text": "你好"}]
}
```

支持消息段：

| 类型 | 结构 |
| --- | --- |
| 文字 | `{"type":"text","text":"内容"}` |
| 图片 | `{"type":"image","media_id":"上传接口返回的ID"}` |
| 视频 | `{"type":"video","media_id":"上传接口返回的ID"}` |
| 本地表情包 | `{"type":"sticker","media_id":"上传GIF/WebP/PNG/JPEG返回的ID"}` |
| 收藏表情包 | `{"type":"custom_face","emoji_id":"收藏查询返回的ID"}` |
| 普通 QQ 表情 | `{"type":"face","id":"0"}` |
| 群聊提及 | `{"type":"at","qq":"QQ号"}` 或 `{"type":"at","qq":"all"}` |
| 回复引用 | `{"type":"reply","id":"原消息ID"}` |

图片、文字和普通表情可组合。当前 SnowLuma 版本要求视频单独发送；收藏表情包也使用独立动作、单独发送。私聊不接受 `at`。接口提前拒绝这些无效组合。文字作为文字段发送，文字中的 `[CQ:…]` 不会自动变成动作。

上传仅接受 PNG/JPEG/GIF/WebP 图片及 MP4/WebM 视频，按文件头识别并限制大小；没有实现完整媒体解码校验。实际编码能否播放仍以 QQ 客户端为准。浏览器不能传入任意磁盘路径、URL、base64 文件或 OneBot action。上传 ID 只能用于同一 QQ 账号、匹配的媒体类型。

回执示例：

```json
{"key":"message_key_001","state":"accepted","message_id":"-123","error":null,"created_at":"时间"}
```

| state | 含义与调用方处理 |
| --- | --- |
| `pending` | 本地已登记，正在调用网关；等待或查询回执 |
| `accepted` | 网关返回成功和消息 ID；不保证对方已收到或已读 |
| `failed` | 明确被账号、鉴权或网关业务校验拒绝 |
| `unknown` | 超时、连接异常、取消、缺失回执或中断；不能判断是否已经发出 |

相同键及相同内容返回原回执，不再次调用发送；相同键不同内容返回 `409 idempotency_conflict`。超时、断线、重启均不会自动重发。`unknown` 应先由用户核对 QQ，再决定是否用新键再次发送。

### 接收与附件

返回消息包含 `seq`、`message_id`、会话、方向、发送者、时间及标准化 `segments`。QQ ID 和消息 ID 均返回字符串；消息 ID 可为负数。群聊发送者名称优先群名片，否则昵称。仅持久化已授权会话的 `message` / `message_sent`；忽略通知、请求、心跳，不保存完整原始事件。

收到的媒体段提供 `ordinal` 和 `media_id=null`；调用 cache 接口后得到媒体 ID，再使用鉴权下载接口。原始 QQ CDN URL不返回给页面。缓存只访问限定的官方 HTTPS CDN，校验 DNS、公网地址、TLS、魔数和大小，拒绝重定向。收藏表情包接口目前返回 ID，未实现收藏预览页面。

轮询使用返回的 `next_cursor`；SSE `event: message` 中 `id` 为 `seq`。重新连接时将最后保存的游标显式作为 `after`，不要依赖自动重连或 Last-Event-ID。浏览器原生 EventSource 不能设置 Bearer 请求头，应使用 fetch 流读取或原生宿主桥接，禁止把密钥放到查询参数中。

本地数据库保留已接收数据，但未实现 NapCat/SnowLuma 断线期间的历史补拉，不承诺断线期间消息完整补回。媒体缓存/消息队列到达限额会拒绝继续写入；没有自动淘汰或清空，需由后续管理功能处理。

## 调用示例（Python 本机客户端）

以下代码会实际发送，只有在明确开启目标会话权限后才运行。密钥通过调用方环境读取，不写进源码：

```python
import os, uuid
from pathlib import Path
import httpx

base = "http://127.0.0.1:8780/plugins/qq-messaging"
headers = {"Authorization": "Bearer " + os.environ["QQ_MESSAGING_API_TOKEN"]}
target = os.environ["QQ_TEST_TARGET"]
with httpx.Client(headers=headers, trust_env=False, timeout=90) as client:
    client.put(base + "/conversations/private/" + target,
               json={"receive_enabled": True, "send_enabled": True}).raise_for_status()
    upload = client.post(base + "/media/image", content=Path("picture.png").read_bytes())
    upload.raise_for_status()
    key = uuid.uuid4().hex
    sent = client.post(base + "/messages/send", headers={"Idempotency-Key": key},
                       json={"conversation_type":"private", "conversation_id":target,
                             "segments":[{"type":"image", "media_id":upload.json()["id"]}]})
    sent.raise_for_status()
    print(sent.json())  # accepted 表示网关接受，不表示对方已读
```

视频改为 `/media/video` 和单独的 `video` 段；表情包改为 `/media/sticker` 与 `sticker` 段。接收使用 `GET /messages`，再显式缓存附件。

## 验证

使用前端 `.venv\Scripts\python.exe`，不连接真实 QQ / 后端：

- `test_qq_actions.py`：14 项通过。
- `test_qq_messaging.py`：26 项通过。
- `test_qq_plugin_status.py`：5 项通过。
- `test_qq_reader.py`：13 项通过。
- `test_message_media.py` 中与共享下载器相关的 URL/DNS、流式限制、媒体解析等 5 项通过。

共 63 项 Windows 定向测试通过。

既有完整媒体回归在 `test_cancelled_download_stays_cancelled_across_restart` 阻塞，已停止本轮测试进程。该旧队列测试没有因本次修改修复；本轮新增缓存取消、权限撤销测试均通过。不能将完整旧媒体套件称为通过。

实际账号验收应使用用户明确指定的测试联系人，依次验证文字、图片、单独视频、GIF 表情包、收藏表情；检查 QQ 窗口与对方接收结果、重启后幂等回执，以及只读 Reader 仍无发送动作。

协议依据：[SnowLuma 官方 API 文档](https://snowluma.github.io/zh/docs/api)、[send_msg 文档](https://snowluma.github.io/zh/docs/api/message/send_msg)，并核对本机安装的 SnowLuma v1.14.20 源码。官方文档与实际版本有差异时，以本次已验证的安装版本为接口适配范围。


## 真实 QQ 文字发送测试 · 2026-10-04

用户明确要求向 `目标测试账号` 发送一条消息。本次核对当前登录的测试账号，通过临时本机 HTTP 测试实例调用同一套前端路由、鉴权、会话权限、SQLite 和 OneBot 动作客户端。

- 内容：`LKA 前端消息接口测试`。
- 时间：`2026-10-04T15:57:25Z`（北京时间 23:57）。
- 前端 HTTP 返回 200，发送回执 `accepted`，消息 ID `1974044847`。
- 再次查询本地回执一致，发出消息已存入测试 SQLite。
- 通过 QQ `get_msg` 只读回查该消息 ID，文字与测试内容一致。
- 仅执行一次发送，没有自动重试；复用持久化幂等键避免重新运行导致重复发送。
- 随后关闭测试会话接收/发送权限，退出临时 HTTP 实例，并恢复 SnowLuma 原配置（saved/applied 均成功）。日常前端服务和后端未重启，实际 `.env` 未启用发送。

本地测试记录位于 `.runtime/qq-send-smoke-20261004.private.json` 和 `data/qq/messaging-smoke.db`，均不提交版本库。QQ 回查确认发送方能读取该消息，不等于接收方已经收到或已读；接收方确认仍待用户观察。
