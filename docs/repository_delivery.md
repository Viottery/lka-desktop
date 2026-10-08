# 前端 Git 仓库交付

当前分发包含 Windows 桌宠、共享聊天与工作台、QQ 插件/消息中心、适配 API、测试、角色资源和启动脚本。独立 LKA 后端通过启动参数连接。

## 配置与运行

根目录 README 提供 Windows 原生安装步骤。`.env.example`、`.env.qq-reader.example` 是不含凭据的模板。虚拟环境、`.env`、QQ SQLite/媒体、NapCat/SnowLuma 安装与登录缓存、日志、运行状态、Java 构建和 Node 依赖不提交。

`data/pet/profiles.json` 是分发角色/动作定义，个人窗口状态 `data/pet/state.json` 保留在本机。

## 提交检查与测试

```powershell
.\.venv\Scripts\python.exe scripts/check-repository.py
.\.venv\Scripts\python.exe scripts/check-repository.py --staged
.\.venv\Scripts\python.exe -m pytest tests/test_qq_reader.py tests/test_qq_actions.py tests/test_message_reading_proxy.py -q
.\desktop-pet-java\gradlew.bat -p desktop-pet-java compileJava verifyPetMotion verifyPetInteraction verifyPetMemoryBridge
```

可选浏览器回归使用 Node.js、Chrome 和 `package.json` 中锁定的 Playwright Core：

```powershell
npm ci
npm run test:sessions
npm run test:chat
```

用 `CHROME_PATH` 指定其他 Chrome 安装路径；已有 Playwright 可用 `PLAYWRIGHT_MODULE` 指定模块路径。浏览器回归使用合成服务。提交检查只输出路径和错误分类，验证代码语法、必要入口/资源、文件大小、运行数据和常见凭据形态；不等同完整秘密扫描。

## 旧文件清理

旧 Docker 配置、Docker 安装脚本、旧 Agentic-RAG 架构与部署文档、初始设计样例、两个 hello 探针、错误命名旧日志和旧备份/冒烟输出移入**项目目录外的本机归档**。具体清单见本机 `.runtime/git-preparation-archive.json` 和归档 `manifest.json`；归档另有 Git 历史 bundle、工作区 patch 与原 README，可恢复。

当前 `app/main.py` 与桌宠兼容接口仍引用 Agent/RAG/runtime 模块，因此保留这些源码及测试。原生 Windows、Windows+WSL、Python 宿主和 Java 宿主相关启动文件保留。没有修改现有运行配置、消息库或登录状态。

## Git 与第三方资源

当前开发仓库为 `lka-desktop`，使用 `main` 分支和独立的干净分发历史。旧目录及其历史
仅保留在本机作回滚；不把旧数据库历史带入该仓库。可由 `git status --short`、
`git diff --cached --stat`、`git diff --cached --check` 审查提交内容；远端推送须另行明确授权。

`.gitattributes` 统一仓库文本换行，Windows 脚本检出为 CRLF，角色骨架/纹理、Gradle Wrapper 等二进制不转换。

角色和图标、Spine/ArkPets/Pixi/Markdown-it 等资源保留已有来源及 vendor 授权文件，分发遵循原有许可；不擅自为整个现有项目补选开源许可证。Java 依赖由 Gradle 下载，QQ 宿主组件单独安装。

## 旧目录整理记录（2026-10-06，历史参考）

- 暂存快照：225 个文件，约 5.3 MB；139 个路径包含交付改动和旧文件移除。
- 当前提交候选检查通过；439 个历史文本 blob 的常见凭据形态扫描没有匹配项，历史未收录 `.env`。两份旧交付记录中的实际 QQ 测试账号和本机用户名已匿名化，原文保留在目录外归档 `sanitized-doc-originals/`。
- Python QQ/代理合成回归：41 passed，31 subtests passed，使用已安装测试依赖的 Linux 测试环境；两个生产 Windows 虚拟环境未安装 pytest，未修改生产依赖。
- Windows Java：离线 compileJava、verifyPetMotion、verifyPetInteraction、verifyPetMemoryBridge 全部通过。
- Windows Chrome：会话生命周期与首次消息回归两组通过，分别 233/67 个合成请求。
- package-lock.json 固定本机已有 Playwright Core 1.59.1，完整性散列已通过正常 TLS 与 npm 官方元数据核对。
- Git 历史和旧文件归档：`D:/agent-bot-frontend-archive-20261006T065724Z`。
- 当前分支和远端保持原值；所有分发改动已暂存，未创建本地提交、未推送。

## 推送前的历史隐私检查

```powershell
.\.venv\Scripts\python.exe scripts/check-repository.py --staged --history
```

历史检查会检查 HEAD 可达的所有版本，包括已删除的二进制数据库。`.gitignore` 和删除当前文件不会清除历史中的内容；旧历史检查失败时，先保留本机备份，再选择独立的干净分发仓库或明确授权的历史清理方案。

WSL 启动器通过选定发行版读取当前用户 HOME，不在分发脚本中写死个人目录。默认后端为该用户的 `~/lka_backend`，可使用 `-BackendRoot` 或本机环境变量 `LKA_WSL_BACKEND_ROOT` 指定。


## 当前前端交付（2026-10-07）

- 桌宠快速会话从小输入框开始，发送后展开阅读区，保留原生 IME 输入、窗口边角拖动、
  手动尺寸和当前会话进入工作台。图标与悬浮说明统一，移除上下文 token 计数。
- 快速会话与工作台直接显示 SSE `assistant_message` 和工具调用状态，最终答案增量渲染并
  在结束后校准；工作台发送时自动滚动到新消息。两侧面板独立开关并保存本机显示偏好。
- 工作区目录选择支持浏览、父目录导航、筛选、取消和确认；远程创建只允许启用的父目录。
- 手机/平板使用共享业务模块、触屏布局和同源后端网关。远程来源在本机 `.env` 配置，
  组网地址、配对凭据和运行数据均不进入提交。现有桌面与 QQ 传输保持各自权限边界。
- 入口脚本读取本机环境与 DPAPI 配对文件，控制凭据只进入 Python 前端适配进程。
- 代码与操作说明见 [桌宠入口](desktop-pet-entry.md)、[移动工作台](mobile-workbench.md)、
  [工作区目录浏览](workspace-browser.md) 和仓库 `AGENTS.md`。

已验证：桌面/快速聊天回归、移动端五种视口与远程域名回归、17 项目录/代理接口测试；
通过已授权组网入口读取历史列表/详情、模型列表并创建临时工作区成功，空验证目录已清理。
各浏览器回归使用合成数据，不启动真实模型任务或发送 QQ 消息。
`npm run test:messages` 跟随当前仓库解析资源，`npm run test:safety-feedback` 检查审批反馈。
提交前的目录和可达历史检查均不应收录 `.env`、`.runtime`、数据库、日志或构建产物。


本次提交整理补充验证：消息中心回归通过（603 个合成请求、3 次模拟发送）；审批反馈检查
通过；Windows Java 离线 `compileJava` 与 `verifyPetMemoryBridge` 通过。分发检查及可达历史
隐私检查通过；提交对象以最终暂存快照为准。运行中的后端、桌宠、QQ 与前端服务未因
本次 Git 整理而重启。


## 当前前端交付（2026-10-08）

- 工作台、手机与 Java 快速会话支持粘贴、选择并混合发送图片、文档和文字，
  使用会话附件接口；手机提供上传入口，Java 原生上传使用 HTTP/1.1。
- 受配置允许的工作台来源可浏览电脑目录，向会话当前工作区上传文件和下载成果；
  文件传输与 Agent 附件分开，保留路径校验、大小限制和取消/重试。
- 消息中心可见时每 5 秒更新会话数量与阅读概览，群名独立加载，过期缓存后台更新；
  保留草稿、滚动与详情，阅读多页后暂停自动重载。
- 快速会话固定滚动条占位、统一高度计算，修复图片加公式回复导致的持续布局循环。

各功能的定向浏览器、原生 Windows Python 和 JavaFX 验证已在实现时完成。
最近验证包括聊天回归、消息中心与刷新专项、15 项群名测试，以及使用真实快速页
布局代码的 JavaFX 图片/公式、延迟图片、长回复、手动缩放和小窗恢复检查。
分发与历史隐私检查以本次最终暂存内容和提交历史为准。
