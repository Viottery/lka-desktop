# 安装与多设备部署

这份说明覆盖两种部署：Windows 电脑运行桌宠/浏览器前端并连接云端后端，以及在 Ubuntu 22.04 云服务器上托管静态工作台。云端不运行 Java 桌宠；Java 桌宠、QQ 接入和本机消息数据留在 Windows。

## Windows 电脑

每台 Windows 电脑分别安装本仓库、Python 3.12+，以及需要桌宠时安装 Java 21。按 README 的安装步骤创建本机 `.venv` 和 `.env`；仅当 `.env` 不存在时从 `.env.example` 复制，再填写该电脑自己的服务地址和来源配置。不要覆盖已有 `.env`。配置云端登录时，将 `LKA_CLOUD_ORIGIN` 设为云端 HTTPS 源；本机前端服务的浏览器来源也须按 `docs/mobile-workbench.md` 配置。

启动浏览器工作台：

```powershell
.\run-lka-windows.ps1 -NoBackend -NoPet -OpenBrowser -BackendHost 127.0.0.1 -BackendPort 8765
```

这里连接该电脑自己的 loopback 节点；不要把远程 HTTPS 地址塞进 `-BackendHost`。
其他电脑的工作台通过顶栏位置菜单或该节点自己的 HTTPS 入口打开。
本机 `.env` 中的 `LKA_WORKBENCH_BACKEND_URL` 应对应自己的 loopback 后端，
云端地址单独填 `LKA_CLOUD_ORIGIN`。

使用桌宠时省略 `-NoPet`、`-OpenBrowser`。每台电脑的普通会话、工作区文件、QQ 数据和前端缓存保存在该电脑；真理、待办、项目与云端记忆以云端后端为准。前端缓存只用于本机界面恢复，不能作为跨设备备份或权威数据。

把代码更新到与后端配套的发布版本后，按仓库 README 的验证步骤检查。每台设备使用各自的云端登录；新设备首次登录时重新认证。Windows DPAPI 配对凭据绑定 Windows 用户，不要复制到另一台电脑或另一用户。不要把普通会话数据库克隆到每台设备；设备连接和授权通过云端设备入口建立。

## Ubuntu 22.04 云端静态工作台

Ubuntu 云端托管浏览器页面和 LKA 后端 API，不安装或启动 Java 桌宠。部署配套 `lka_backend`，启用云端/hub 配置、HTTPS 反向代理和访问控制；在后端配置中把 `[client].workbench_dir` 指向此仓库的 `app/web/pet` 目录。若由 Web 服务器直接提供静态文件，则将 `/desktop-pet/` 映射到该目录，并把其余 API 路径代理给后端。`/desktop-pet/connect.html` 应由同一 HTTPS 源提供。不要将后端 API 暴露到未受保护的公网地址。

先从 `docs/multi-device.md` 和配套后端 `docs/deployment_migration.md` 完成云端首次设置、备份与迁移，再登记每台电脑。静态工作台代码与后端必须使用配套版本；发布时记录两个仓库的提交号。页面、缓存和 Service Worker 属于前端发布内容，云端数据库、账号、共享记忆和运行数据属于后端持久数据；升级静态文件不会迁移或替代后端数据。保留并备份云端既有数据，不要通过重建数据库或覆盖环境配置来升级。

移动设备在浏览器打开云端 `/desktop-pet/connect.html` 登录后进入已登记电脑。所有设备需使用可验证的 HTTPS 地址；首次部署后检查登录、设备进入、工作区权限、Service Worker 更新和云端断开提示。手机只保存浏览器侧登录状态与界面缓存，不保存节点的普通会话或工作区文件。

更完整的设备边界、入口和节点权限见[多端协同](multi-device.md)；后端数据迁移步骤见配套后端的 `docs/deployment_migration.md`。

本机后端是 replica 且云端已登录时，记忆的高级设置和模型目录来自云端。
保存设置不会重启服务；需要重启时操作对应的云端后端，不是新建或清空本机数据库。
