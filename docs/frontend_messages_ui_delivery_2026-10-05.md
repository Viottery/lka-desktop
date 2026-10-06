# QQ 与 Message 前端适配交付

日期：2026-10-05。工程：`D:\agent-bot-frontend`。

## 1. 范围与完成清单

- [x] 核对 QQ Reader、QQMessaging、后端消息历史、阅读、名称、上下文、媒体和人物档案的现有接口。
- [x] 增加工作台「消息中心」；桌宠快速窗口通过消息气泡图标打开工作台，保留快速任务交互。
- [x] 会话优先显示备注或名称，显示平台、账号、群号/QQ 号用于核对；支持本地过滤、精确定位、分页。
- [x] 消息原文按时间展示，历史分页、关键词搜索、作者名称/ID 和接收时间筛选、上下文定位。
- [x] 接入附件记录、图片查看和视频播放；缓存不可用或权限撤销时显示明确提示。
- [x] 保留已有主题、洞察、参与者、关注规则、事项候选逐项确认及阅读后台管理。
- [x] 阅读会话改为名称下拉选择，阅读模型从模型目录选择；技术进度和原始配置放入折叠详情。
- [x] 增加持久人物档案和原文证据分页；区分有证据的观察、未采纳的模型记录、人工更正和有效期。
- [x] 接入本机 QQ 手动发送：文字、图片、视频、本地表情包、收藏表情；权限与采集、模型阅读分开。
- [x] 收件会话/号码/来源账号/内容确认后发送；Enter 进入确认，Shift+Enter 换行，支持输入法组合输入。
- [x] 发送、上传、断线期间仍可写草稿；草稿按会话保留在页面内存，发送成功保留下一条草稿。
- [x] 发送结果未知时禁止盲目重发，提供回执查询；查询确认成功后清理原草稿并合并本机发信记录。
- [x] 本机发信记录与后端同步记录按 provider message ID 去重。
- [x] 滚动区和输入区自适应；窄窗口展开筛选后输入区保持可见，筛选/回执可独立滚动。
- [x] 保留未保存的权限编辑，关闭页面停止消息轮询，重开阅读页刷新，支持 Esc、Tab 和焦点恢复。
- [x] 浏览器与 Java 桌宠使用同源前端适配层；凭据留在服务侧。
- [x] 完成隔离浏览器、Python、Java 原生桥验收，加载新版前端与 Java 桌宠。

本轮未修改后端代码或部署后端，未调整生产会话的记录/分析授权、阅读预算或发送总开关，未发送真实 QQ 消息。

## 2. 使用方式

工作台顶部「消息」或设置中的「消息与 QQ」进入消息中心：

1. **消息**：选择会话，查看原文、搜索、上下文和附件；底部编辑 QQ 草稿。
2. **阅读**：主题、洞察、活跃参与者、关注规则、事项候选与原文依据。
3. **人物档案**：持久观察、模型记录、人工更正与来源消息；后端未提供接口时指向已有参与者页面。
4. **设置**：本机 QQ 会话收发权限、阅读模型与后台预算、会话记录/分析/媒体策略。

入口：`http://127.0.0.1:8780/desktop-pet/chat.html?mode=work&panel=messages&backend=http%3A%2F%2F127.0.0.1%3A8765`。

打开页面只读取，不自动开启采集、分析、媒体缓存或 QQ 发送。会话名称解析为精确匹配；同名结果需要核对账号和号码。搜索时间按当前后端实际实现的**接收时间**处理。

## 3. 接口与实现

| 功能 | 适配接口 | 约束 |
| --- | --- | --- |
| 会话目录与名称 | `/messages/conversations`、`/resolve`、`/{key}/metadata`；旧服务 `/messages/policies` | 50 条分页；名称修改携带 revision，冲突保留编辑；旧服务仅更新已有策略名称与所需调度字段 |
| 原文与搜索 | `/{key}/history`、`/messages/search` | 历史 before_seq；搜索 offset；关键词/作者最多 256 字符 |
| 上下文 | `/messages/records/{id}/context`；旧服务 `/{key}/history` | 初始前后各 10 条，边缘每次继续 25 条；独立详情页、目标高亮、双向分页；404 时兼容已有历史 |
| 人物档案 | `/messages/reading/dossiers`、`/{key}/{sender}`、`/sources` | offset 分页；模型记录不当作已采纳事实 |
| 阅读后台 | 既有 reading/focus/proposals/background 接口、`/agent/models` | 保留逐项确认与 revision 防冲突 |
| 后端附件 | `/messages/attachments`、`/{id}/content` | 同源二进制代理；白名单 MIME、单 Range、大小限制 |
| 自动 QQ 群名 | `/plugins/qq-ui/groups/{group_id}?account_id=...` | 独立于发送开关；只返回绑定账号已加入的指定群名，备注优先；5 分钟缓存 |
| QQ 状态/权限 | `/plugins/qq-ui/status`、`/capabilities`、`/conversations/{kind}/{id}` | QQMessaging 和全局发送默认关闭；账号核对、会话授权沿用现有实现 |
| QQ 消息/回执 | `/plugins/qq-ui/messages`、`/messages/send`、`/sends/{key}` | 不自动重试发送；持久幂等键沿用现有服务 |
| QQ 媒体 | `/plugins/qq-ui/media/{kind}`、`/media/{id}`、`/stickers` | 原始文件字节上传；视频/收藏表情单独发送 |

`/plugins/message-reading/*` 只代理精确允许的后端路径及查询参数。控制凭据由前端进程持有，网页不再填写管理 Token。QQ UI 写请求必须携带 `X-LKA-UI-Intent: 1`，同时检查本机客户端、Host、同源 Origin/Fetch-Site。Java JSON 桥走同一前端源，使用 HTTP/1.1；不转发页面 Token。文件上传和预览使用同源 HTTP，避免大文件经过 JS→Java JSON 桥。

关键文件：

- `app/web/pet/messages-center.js`、`messages-center.css`：消息中心交互和布局。
- `app/web/pet/message-ui-api.js`：浏览器/Java 统一消息传输。
- `app/web/pet/message-content.js`：消息历史、原文证据和上下文统一的文本/非文本卡片，私有 CQ 链接不进入 DOM。
- `app/plugins/qq_group_names.py`、`message_ui_content.py`：本机群名只读查询、缓存、账号绑定及安全媒体类型补充。
- `app/web/pet/message-names.js`：名称优先级、备注修改及仅在 metadata GET 404 时启用的旧策略兼容。
- `app/web/pet/chat.html`、`message-history.js`、`message-reading.js`、`qq-reader.js`：入口与已有页面适配。
- `app/api/routes/qq_ui.py`、`message_reading_proxy.py`、`plugins.py`：本机同源适配与媒体代理。
- `desktop-pet-java/.../PetControlWindow.java`：扩展精确白名单和前端代理路由。

## 4. 验收结果

所有写入/上传/发送测试使用临时数据库、合成消息和模拟网关。

| 验证 | 结果 |
| --- | --- |
| `test_message_ui_adapters.py` | 6 项通过：本机边界、无凭据泄漏、幂等/权限、上传、媒体流与 Range |
| `test_message_reading_proxy.py` | 12 项通过：精确接口/查询、编码路径、私有鉴权、错误净化、请求限制 |
| `test_qq_plugin_status.py` | 5 项通过：Reader 默认关闭、状态净化与访问边界 |
| `test_qq_messaging.py` | 26 项通过：既有收发、权限、账号、媒体、幂等及未知回执回归 |
| `test_qq_actions.py` | 14 项通过：动作客户端、账号核对、超时/拒绝不重试 |
| `test_reading_java_allowlist.py` | 1 项通过：原生路径/查询白名单与非法请求 |
| `gradlew.bat --offline classes verifyPetMemoryBridge` | 编译与实际 JavaFX WebView→Java→双本地 HTTP 服务→回调通过；验证 reading GET/QQ 合成 POST 来源、方法、意图头、无 Token、UTF-8、HTTP/1.1 |
| `tests/frontend_messages_smoke.cjs` | Chromium 隔离验收通过：会话/搜索/证据/媒体/确认/草稿/回执/模型/滚动/响应式/Java 回调/焦点/兼容降级；新增立即进入详情、错误重试、嵌套原文导航、返回保留位置、双向历史、分页结束按钮、名称 Enter 保存与 Markdown |
| `tests/frontend_message_names.cjs` | 通过：名称优先级、现代 metadata CAS、旧策略兼容、不扩大授权、403 不降级、409 保留冲突、禁止新建策略 |
| `tests/frontend_reading_profiles_smoke.cjs` | 通过：参与者修订、409 保留草稿、证据、关注规则及可信用户写入交互 |

复现 Python：`.venv\Scripts\python.exe -m unittest discover -s tests -p test_message_ui_adapters.py -v`，其余测试替换文件名。

浏览器测试使用现有 Windows Chrome、Node 和 playwright-core，可通过 `PLAYWRIGHT_MODULE` 指定模块目录。截图为合成数据：

- `.runtime/messages-ui-smoke/messages-1440x900.png`
- `.runtime/messages-ui-smoke/messages-430x680.png`
- `.runtime/messages-ui-smoke/reading-detail-1440x900.png`
- `.runtime/messages-ui-smoke/message-context-1440x900.png`
- `.runtime/messages-ui-smoke/message-context-430x680.png`
- `.runtime/messages-ui-smoke/messages-media-1440x900.png`
- `.runtime/messages-ui-smoke/messages-media-430x680.png`

## 5. 本机运行核对与限制

初次交付时已重载前端 Python 服务与唯一的本项目 Java 桌宠，桌宠原启动参数/角色 profile 保留。后端进程核对未变化。QQ Reader 启用状态保留，重连后为 `connected`、同步 `idle`；重启期间平台事件的完整补回不作保证。

实际同源接口核对：

| 接口 | 当前服务返回 |
| --- | --- |
| 会话目录 | HTTP 200 |
| 模型目录 | HTTP 200 |
| 新版会话 metadata | HTTP 404 |
| 持久人物 dossiers | HTTP 404 |

当前可以直接使用已有会话名称/策略名称、原文和既有阅读页面。本次交互修订增加以下兼容：

- **群聊名称**：优先显示已有备注/手动名称，否则自动显示本机 QQ 群资料中的群名。QQ Reader 的 sender.card 是发言者群名片，不用它冒充群名。获取失败时保留本地名称或显示“未命名群聊”及群号，手动备注是可选功能。自动名称也供阅读选择器、上下文及设置中的会话标题使用。
- **名称保存**：新版使用 metadata 的 revision；metadata GET 返回 404 时，读取精确匹配的已有策略，以 expected_revision 更新名称和接口所需的原有调度值。请求不携带记录、分析、媒体等授权字段；已核对当前 Windows 后端会保留省略的策略字段。403、503 或写入失败不降级，不新建策略。
- **前后原文**：新版 context 不可用且返回 404 时，使用已有 history 分页定位。消息有 seq 时支持双向继续加载；没有 seq 时只在最近 100 条中查找目标，超出范围明确提示，并提供“打开会话”。不宣称完整补回 QQ 历史。
- **仍需后端部署**：持久人物档案、精确名称解析及新版覆盖信息。运行时不存在的接口显示兼容提示；本次没有部署后端。

详情导航修订修改静态 UI；后续群名/媒体修订扩展了 Windows 前端本机服务，并重载前端及 Java 桌宠。当前 QQ 登录会话和后端进程保持不变。已有浏览器页面刷新后加载最新版本。

当前 `QQMessaging` 与发送总开关仍为关闭。消息中心会显示原因，草稿仍可输入；本轮没有为使按钮可用而修改生产配置。真实图片/视频发送、对方接收/已读未在本轮验收。收藏表情接口只返回 ID，选择页显示编号，不伪造缩略图。

草稿与 UI 待查回执标识仅在当前页面内存中保存，刷新/退出不会保留草稿；底层发送回执仍持久化。关闭窗口再打开同一页面会刷新消息。当前原文视图仅加载最近 50 条附件元数据；更早的附件不会自动预览，未实现完整附件图库。QQ 原文保持文本；阅读结果的 AI 摘要使用已有安全 Markdown 渲染，支持标题、列表、加粗等。

未提交或推送代码；保留仓库中已有修改。


## 6. 本次交互修订：可执行清单与完成结果

- [x] 桌宠入口改为 SVG 消息气泡图标，保留悬停提示、无障碍名称和键盘焦点。
- [x] 将阅读“打开详情和原文”、参与者、关注规则、人物档案和旧设置里的摘要统一到独立详情视图；点击立即出现标题及加载状态。
- [x] 采用“列表 → 详情 → 前后消息”的导航；逐级返回、Esc 返回，保留列表滚动、嵌套详情位置与可用焦点；未保存编辑仍有离开保护。
- [x] 主列表和详情独立滚动，不把新增详情追加在所有页面底部；阅读时暂停列表自动刷新。
- [x] 来源消息显示作者和时间，并可进入前后消息视图；目标消息高亮，可回到目标、加载更早/较新消息、打开所属会话。
- [x] 展示加载失败原因和重试入口；结束分页保持按钮禁用；迟到响应不覆盖已离开的视图。
- [x] 名称与号码分层展示，长名称截断；提供小型名称编辑弹窗，Enter 保存，冲突保留输入。
- [x] 完成 1440×900 和 430×680 合成消息浏览器验收，验证上下文无横向溢出，既有发送草稿/权限保护不回退。
- [x] 同步工程文档；本次未执行真实 QQ 发送，也未修改生产授权或后端代码。

旧按钮“没有反馈”的原因：详情被写入长列表底部，没有导航、滚动定位或立即加载提示。现在点击后直接进入专门的详情区域；返回恢复列表位置。


## 7. 群名自动读取与非文本消息修订

### 完成项

- [x] 自动读取当前登录账号的 QQ 群名，不要求用户手动填写；手动备注继续保留。
- [x] 发送关闭时仍支持群资料读取；服务端按账号核对，仅返回请求的已加入群，异常不跨账号使用缓存。
- [x] 限定群资料适配仅可调用 get_login_info/get_group_list/get_group_info；凭据保留在 Windows 服务中，页面不接触 Token 或密码。
- [x] 群目录缓存 5 分钟，失败后 30 秒退避；暂时故障的旧缓存显式标记 stale，账号变更清除缓存。
- [x] 图片、视频、表情包、QQ 系统表情、语音、文件、转发/卡片等提供图标与类型说明；已缓存图片/视频可在本页面查看，收起视频会暂停播放。
- [x] 等待缓存、过期、失败、未保存内容均显示说明；无法识别的旧非文本消息明确提示在 QQ 查看，不留空白。
- [x] QQ Reader 新消息在本机 payload 保存至多 100 个安全 ui_content_parts；只保留类型、顺序、表情数字编号或安全文件名，不包含私有 URL、路径、Token 或原始事件，也不加入后端同步协议。
- [x] 在后端成功返回的已授权原文上关联本机类型标记；核对精确会话、当前 revision/epoch、同步及隔离状态。兼容当前后端只返回 conversation_key 的数据形状。
- [x] 消息历史、搜索、阅读来源和前后消息使用同一内容显示方式；窄窗口无横向溢出。

### 当前机器接入方式

最初的普通动作查询失败原因是当前 QQ 只开放事件网络，QQ_ACTION_TOKEN 为空，普通 HTTP 动作接口尚未配置。当前已改用现有、已配对的 SnowLuma 本机管理服务查询群资料：

- 本机私有 `.env` 配置 `QQ_METADATA_URL` 和 `QQ_METADATA_CREDENTIAL_PATH`；只指定本机服务及已有的私有控制文件。
- 管理会话过期时在服务进程内使用已有配对密码重新登录；新 Token 只保存在内存，不写到网页、URL、localStorage 或交付文档。
- 查询使用 `/api/qq-list` 核对账号、`/api/debug/invoke` 调用明确的群资料只读动作；本次没有启用 OneBot HTTP 动作网络，也没有修改 QQ 的 snapshot 配置。
- 当前 QQMessaging 与发送开关均保持 false。Reader 重载后为 connected / idle；后端进程未变化。

### 实际核对与限制

通过已登录 QQ 的只读群目录查询，160 个群均有群名；再通过运行中的同源前端接口抽查 3 个已记录群聊，均为 HTTP 200，群名非空，账号与群号精确匹配。验证过程没有发送 QQ 消息，不在输出中记录群名、正文或凭据。

旧消息若采集时未保留具体媒体类型，无法凭空恢复图片或表情内容；统一显示非文本说明。此后采集的消息可以显示已保留的具体类型。查看媒体仍遵循既有缓存/会话许可，不会为了预览自动扩大授权或下载未授权媒体。当前附件索引的历史加载范围仍受第 5 节限制。

验收：Chromium 合成页面通过自动群名、备注优先、账号隔离、媒体说明、阅读证据、上下文及响应式检查；`frontend_message_content.cjs` 与名称/阅读契约检查通过；实际 JavaFX 原生桥通过新增群名 GET、账号查询参数、同源及无凭据回调检查。Python 的本地标记/消息代理/Reader 共 29 项、群名与管理会话续期 11 项、现有动作客户端 14 项、Java 白名单 1 项定向测试通过。


## 2026-10-06 人物昵称修订

原因：当前后端的活跃人物画像接口返回 `conversation_key`、`sender_id`，不包含 `sender_name`。页面此前把 `sender_id` 作为名称回退，因此显示 QQ 号。

- 前端本机代理为人物列表、档案列表及详情补充名称：仅从已同步、未隔离、当前仍获准记录的本地消息中读取最近有效 `sender_name`。QQ Reader 原有标准化优先保留群名片，空名片回退昵称。
- 关联同时核对完整会话身份、账号、当前策略修订及采集 epoch，不跨账号或会话借用姓名。数据库以只读方式打开；缺库或没有匹配名称时保持可用，不创建数据库。
- 列表以昵称或群名片为主，QQ 号独立显示在次要信息中；详情返回新的昵称时更新页面标题。确实没有名称的历史记录显示“未获取昵称”，QQ 号仍可用于核对。
- 本次仅改前端页面与本机适配，未修改后端、未触发真实 QQ 发送或新增联系人查询。

主要文件：`app/plugins/message_people.py`、`app/api/routes/message_reading_proxy.py`、`app/web/pet/message-names.js`、`message-reading.js`、`messages-center.js`、`messages-center.css`。

验证：Windows 原生 Python 的人物名称测试 4 项、消息代理测试 14 项全部通过；名称契约与阅读画像交互检查通过；真实 Chromium 合成页面测试通过，包含列表昵称、次要 QQ 号、详情昵称刷新及既有消息交互。Windows 实际人物 API 检查由 8 条记录中 0 条包含昵称变为 8 条全部包含昵称，核验工具仅输出计数。前端服务和 Java 桌宠已重新加载，后端保持运行、Reader connected/idle，QQ 发送总开关仍为关闭。桌宠继续使用 `javaw.exe`，不创建命令窗口。

当前运行后端的持久档案接口仍返回 404，界面继续提供“阅读 → 参与者”的入口；现有活跃画像昵称已实际验证，持久档案名称适配通过合成测试。
