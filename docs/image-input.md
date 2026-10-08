# 文件、图片与文字混合输入

## 使用

- 工作台和手机/平板：输入框旁的 `＋` 可选择图片或文件，一次多选、混合选择后，
  添加文字说明并发送；也可以只发送附件。系统支持时可直接混合粘贴文件、图片和文字。
- Java 桌宠快速任务：原生输入框 Ctrl+V 支持截图、复制的图片和文档文件；
  上传按钮可混合选择文件。普通文字粘贴、输入法和 Enter/Shift+Enter 行为保持一致。
- 待发送区显示缩略图/文件类型、名称、大小、上传与解析状态，以及移除按钮。
  文档由电脑上的后端解析，上传成功即取得本次会话的附件 ID。
- 发送会等待所选附件完成上传；任一附件失败就停止提交 Agent 任务，保留可重试附件。
  Agent 处理时仍可编辑下一条文字和附件草稿。失败恢复不会覆盖新草稿或超过附件数量。
- 会话历史中，图片可点击查看原图，文档可下载原文件；仅保存 ID 的旧会话会读取
  元数据恢复附件类型和名称，避免把文档显示成图片。

## 支持格式和限制

每轮最多 4 个附件，图片与文档合计。支持的文档类型读取后端
`GET /knowledge/file-types` 中的 `index_supported: true` 项。
目前包括 TXT/TEXT、Markdown、PDF、DOCX、PPTX、XLSX/XLS、HTML/HTM、EPUB、CSV、
JSON、XML 和 MSG。DOC/PPT、压缩包、音视频等不在本次文档附件范围内。

单个文档最多 64 MiB；加密、损坏、无可提取文字等解析失败会明确报错。
PDF 依赖文字层，扫描件需要先 OCR 或改为图片上传。Office、PDF 等格式可能遗漏布局、
图片、公式或部分页面；前端显示解析提示，不能把“上传完成”视作全文视觉理解。

图片支持 PNG、JPEG、WebP；原始图片最多 20 MiB，上传结果最多 10 MiB、400 万像素。
超限的静态 PNG/JPEG 会压缩后上传，并显示说明；WebP 超限请自行缩小。
GIF、HEIC 等格式未适配。包含图片时，所选模型需有后端声明的视觉能力；
纯文档不要求视觉模型。前端不自动切换模型或降级丢弃附件。

移动端使用用户粘贴事件和系统文件选择器，不依赖主动读取剪贴板 API。
系统不支持图片/文件粘贴时，请使用上传按钮；手机软键盘和选择器需实机试用。

## 协议、缓存与历史

所有新附件统一上传到 `/sessions/{session_id}/attachments`，先创建/绑定会话与工作区。
请求是原始二进制字节，文件名放入 percent-encoded `X-Filename`；图片使用实际
`image/png/jpeg/webp` MIME，文档使用 `application/octet-stream`。
成功返回 `attachment_id` 和 `kind`（image/document），文档还返回解析元数据。
JavaFX 21 快速窗口上传时用 FileReader 把内存 File 转为 ArrayBuffer 请求体，
避免打开 File 请求体失败后抛空指针、上传 Promise 永不结束。WebKit 初始化前选择
HTTP/1.1 URLConnection 加载器：默认 HTTP2Loader 的 h2c 升级上传在 Uvicorn 下
会出现空请求体和随后 HTTP 400；只转换 ArrayBuffer 并不足以保证 Uvicorn 兼容。
默认本机 8765 后端的快速窗口、工作台请求统一走既有同源 `/workbench` 网关，
避免兼容加载器的跨端口 CORS 预检差异影响历史、设置和上传；显式其他后端地址不改写。
普通浏览器继续直接传 File。图片上传等待最多 60 秒，文档上传与解析最多 240 秒；
超时会中止网络请求、显示错误，保留附件并恢复发送按钮以便重试。
两种 Agent turn、浏览器 SSE 和 Java 桥都传递同一 `attachment_ids` 数组。
纯图片/文档可不带文字，历史占位分别为 `[Image input]`/`[File input]`；界面显示附件卡片。
只发文字时显式发送 `attachment_ids: []`，不自动重复选择上轮附件。

远程页面通过已有 `/workbench` 本机网关上传和下载，沿用来源限制与固定后端地址。
文档请求与下载单独允许 64 MiB，图片保留 10 MiB，普通 JSON 请求额度保持原值。
文档下载保留 `Content-Disposition: attachment`，HTML 等文档不会作为页面内联执行。
显式自定义后端仍使用该地址，不把会话发送到另一台服务；前端不处理 NapCat 凭据。

成功上传的草稿仅保存 ID、名称、类型等显示信息；文件字节、图片编码和提取全文不会
写入 localStorage 或消息 JSON。切换会话保留各自草稿；刷新恢复已上传的附件，
尚未上传成功的文件需重新选择。跨设备共享已发送历史，不共享待发送草稿。
后端不自动把这些附件导入知识库或后台记忆。

旧版 `/pet/composer-files` 的电脑本地缓存仍保留，原文件没有删除或自动发送。
旧缓存没有会话附件 ID，界面提示“旧缓存 · 重新选择后发送”；重新选择文件即可走新版接口。

## 验证

`npm run test:images` 覆盖工作台、移动端、快速页面和原生输入模式：混合粘贴、
立即发送、文件单独发送、原始二进制传输、合计数量、会话隔离、失败与重试、
历史元数据恢复和安全文档卡片。`test:chat`、`test:mobile` 验证既有交互。
Python `tests.test_workbench_proxy` 用假上游检查 10/64 MiB 边界、下载响应头、
来源限制、类型目录与错误信息；旧缓存测试继续保障原数据兼容。
Java `previewQuickConversation` 检查真实剪贴板、混合 TXT/PDF 文件、PNG 像素、
普通文字和异步会话隔离。回归使用合成数据，不启动真实模型或发送 QQ 消息。


单独验证 JavaFX 原始字节上传（不依赖 Robot 焦点，不连接日常后端）：

```powershell
.\desktop-pet-java\gradlew.bat -p desktop-pet-java --offline previewQuickConversation -PfrontendRoot=D:\lka-desktop\app\web\pet -PbinaryUploadOnly=true
```

此检查通过独立本机合成 HTTP 服务接收图片和文档的真实 POST，校验二进制字节、
Unicode 文件名、MIME 与可供任务提交的混合附件 ID。普通浏览器回归另覆盖上传
超时后不创建 Agent 任务、保留附件及成功重试。


与运行服务一致的 Uvicorn 严格同源测试（含 5,044,639 字节 PNG）：

```powershell
.\scripts\check-native-upload.ps1 -JavaHome $env:JAVA_HOME
```

脚本启动临时随机 loopback 端口的 FastAPI/Uvicorn 合成服务，经实际 JavaFX WebView
上传小图片、文档和大图片，再逐字节校验接收结果。临时服务只使用内存，结束后关闭；
不连接日常后端、不创建真实会话、不调用模型。此检查避免宽松 HTTP 测试服务器掩盖
HTTP 协议及请求体解析差异。
