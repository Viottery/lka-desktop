# 理事所 · Windows 桌宠与工作台

当前项目为 Local Knowledge Agent OS（LKA）提供 Windows 桌宠、快速任务窗口与浏览器工作台。角色名为**真理**。聊天、Markdown、会话回收站、工作区、记忆与项目页面通过独立 LKA 后端运行；可选 QQ 插件负责本机采集、缓存、同步、消息浏览及已明确启用的发送接口。

## 首次运行（Windows 原生）

准备 Python、Java 21，以及独立的 `lka_backend` 项目。后端的配置、模型和数据库由后端项目维护。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
# 可选 QQ WebSocket 依赖；按需启用插件并填写本机凭据
.\.venv\Scripts\python.exe -m pip install -r requirements-qq-reader.txt
.\desktop-pet-java\gradlew.bat -p desktop-pet-java compileJava
.\run-lka-native-windows.ps1 -BackendRoot C:\Projects\lka_backend
```

浏览器工作台：`http://127.0.0.1:8780/desktop-pet/chat.html?mode=work&backend=http%3A%2F%2F127.0.0.1%3A8765`。
仅浏览器模式：启动参数添加 `-NoPet -OpenBrowser`。可用 `-BackendPort`、`-FrontendPort` 调整端口。

## 目录与配置

- `app/web/pet/`：共享聊天 UI、工作台、消息中心和静态资源，无单独打包步骤。
- `desktop-pet-java/`：JavaFX/libGDX 桌宠、原生窗口和消息桥接；包含 Gradle Wrapper。
- `app/plugins/`、`app/api/routes/`：Windows 侧 QQ 插件与前端适配 API。
- `data/pet/profiles.json`：随仓库分发的角色与动作定义；个人窗口状态位于被忽略的 `data/pet/state.json`。
- `.env.example`、`.env.qq-reader.example`：无凭据的配置示例。`.env`、运行数据、QQ SQLite、媒体、NapCat/注入组件和依赖缓存留在本机。
- [仓库交付与提交检查](docs/repository_delivery.md)：测试、提交范围、第三方资源与远端准备。
- [Windows 原生运行说明](docs/windows-native-runtime-guide.md)；[会话交互修复](docs/frontend_session_ux_delivery_2026-10-06.md)。

## 验证

```powershell
.\.venv\Scripts\python.exe scripts/check-repository.py
.\.venv\Scripts\python.exe -m pytest tests/test_qq_reader.py tests/test_qq_actions.py tests/test_message_reading_proxy.py -q
.\desktop-pet-java\gradlew.bat -p desktop-pet-java compileJava verifyPetMotion verifyPetInteraction verifyPetMemoryBridge
```

浏览器回归依赖见 `package.json`，安装后执行 `npm run test:sessions` 或 `npm run test:chat`。默认使用 Windows 本机 Chrome；其他安装位置用 `CHROME_PATH` 指定。浏览器测试使用合成 HTTP 服务。

## 兼容模块与资源

现有入口仍引用 `app/agent/`、`app/rag/`、`app/runtime/`，这些模块和对应测试继续纳入仓库。旧 Docker 部署、旧架构规划与手工探针已移出项目目录，归档清单见 `docs/repository_delivery.md`。Windows 与 WSL 组合运行可使用 `run-lka-windows.ps1`。
