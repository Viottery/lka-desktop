# Windows 检查和应用更新

Git 源码安装提供两个双击入口，放在前端仓库根目录：

| 入口 | 行为 |
| --- | --- |
| `Check-LKA-Update.cmd` | 检查远端版本，显示当前与目标提交，不更换运行代码 |
| `Update-LKA.cmd` | 检查版本、备份、更新代码、安装变化的依赖、编译变化的 Java 代码并验证 |

也可以右键这些文件，发送到桌面快捷方式。首次安装仍需按 README 安装 Git、
Python、前后端虚拟环境和 Java；更新器不安装这些系统组件，不需要管理员权限。
发行 ZIP/私人便携包没有 Git checkout 时，不能使用这两个入口。

## 每次更新

1. 先用检查入口查看版本。网络或 GitHub 不可用时会停止检查，保留当前版本。
2. 等待任务结束，再退出桌宠、前端服务以及本次要更新的原生后端。
   仅关闭浏览器窗口不会停止 Python 服务。用原来的启动终端或服务管理器退出。
3. 双击 `Update-LKA.cmd`。完成后从原快捷方式启动，检查后端 `/health`、
   工作台登录、已有会话与设备连接。

更新器不会强制终止进程，不会启动、重启或重新注入 QQ，也不发送消息。
它检查选定 checkout 下的 Python/Java/uv 进程和已配置的监听端口；
自定义端口必须登记在下方配置中。后台任务是否已结束仍需在原服务中确认。
检查入口可以在应用运行时使用；应用入口检测到服务仍运行会明确阻止更新。

## 配套前后端与本机模式

发布通道是官方 `Viottery/lka-desktop` 仓库的 `main`。
该提交的 `release-channel.json` 声明发布名称和完整后端提交号；
前端版本为本次抓取的通道提交。仅从官方 origin 取代码，两个本地 checkout 均须为
干净的 `main`，只允许快进更新。未提交修改、本地额外提交、分叉、
缺失或无效清单均会阻止应用；不自动 stash，不 reset，不覆盖用户代码。
GitHub 仓库发布权限就是通道的信任边界；目前没有独立签名的发行资产或定时自动更新。
发布树中的真实配置、凭据、数据库与运行日志路径仍会被拒绝。后端官方合成夹具
`evals/fixtures/files/local_ops_project/logs/system.log` 是唯一日志路径例外，
仅当目标提交将它记录为普通 Git 文件时允许通过；本地同名文件或符号链接不构成授权。

默认 `backend_mode=external`，只更新 Windows 前端。采用 WSL 后端的这台开发电脑
保持此模式；云端或 WSL 后端由其原有部署流程更新到显示的配套提交，
不由 Windows 工具更新 Linux 目录或启动另一份原生后端。

本机可选配置位于 `.runtime/update-settings.json`，不进入 Git。
可从 `scripts/update-settings.example.json` 复制；默认端口为前端 8780、后端 8765。
运行于其他端口时，填写实际端口，例如 `"frontend_ports": [18780]`。
使用自定义数据/密钥路径的前端，应把这些绝对路径加入 `backup_paths`；
它不会自动解析 `.env` 并猜测每个插件的外部持久路径。
安装过可选 QQ Python 依赖且需要一起更新时设 `qq_dependencies=true`；
不会更新 SnowLuma/NapCat 宿主或 QQ 客户端。

纯 Windows 电脑可明确配置为同时更新原生后端：

```json
{
  "backend_mode": "native",
  "backend_root": "C:\\Projects\\lka-backend",
  "backend_data_dir": "C:\\Projects\\lka-backend\\data\\runtime",
  "backend_config_file": "C:\\Projects\\lka-backend\\config\\local.toml",
  "frontend_ports": [8780],
  "backend_ports": [8765],
  "qq_dependencies": false,
  "backup_paths": []
}
```

必须填写实际正在使用的数据目录和 TOML，数据目录必须包含既有 `lka.sqlite3`。
后端与前端须是两个独立 Git checkout；原生后端须已安装 uv。
前端依赖变化时用现有 `.venv` 的 `python -m pip install -r ...` 安装，
不额外全量升级已满足条件的依赖；后端使用 `uv sync --locked`。
Java 源码或构建配置变化时执行 `compileJava`，需要 Java 21 和依赖下载网络。

## 备份、失败和中断

每次应用先在 `.runtime/updates/<时间-标识>/snapshot-*/` 保存：

- 前端 `data/`、私有 `.env*` 和 `.runtime/` 下的 DPAPI 配对文件；
- 原生模式下指定的整个后端数据目录、私有 TOML 和后端 `.env`；
- `backup_paths` 中显式指定的外部路径；
- 两个仓库的 Git bundle、原提交及 SHA-256 备份清单。

SQLite 使用 backup API 并检查完整性，包含已提交的 WAL 内容。
备份不跟随符号链接；遇到链接会停止，需先明确备份其真实路径。
完整数据可能很大，需预留空间。模型缓存、附件等只要位于选定数据目录内也会复制。
QQ 宿主、外部媒体、系统用户凭据等不自动打包；原文件与配对保持原位。
这些目录含私人数据，不可上传 GitHub；旧备份由用户在确认恢复能力后自行清理。

依赖下载、安装、编译或验证失败时，代码可能已经快进，**不代表更新成功**。
状态文件逐项记录 `source_applied`/`validated`，原服务保持停止；
不要在未完成的版本上继续日常工作。修复网络/系统依赖后再次双击同一入口，
会校验旧备份，按保存的提交继续完成，不跳到另一个新版本，
并另存新快照而不覆盖第一次备份。检查入口也会提示有未完成更新。

工具不自动回滚代码、依赖或数据库迁移。需要退回时，保留失败目录，
用旧 Git bundle 在新目录恢复旧提交并重建虚拟环境；停止所有写入后，
核验备份清单并按原数据迁移流程恢复同一份数据和私有配置。
不要直接把旧 SQLite 覆盖到运行中的进程，也不要混合恢复两个版本的部分表。

## 发布者更新通道

先验证后端并提交，取得完整提交号；在前端 `release-channel.json` 更新版本与该提交号，
完成配套前后端验证后再提交并推送。后端提交须先在官方远端可取到，
然后发布前端 `main`，避免设备取到尚不可下载的配套提交。
清单不写自己的前端 SHA，避免提交自引用；通道提交就是前端 SHA。
合并到 `main` 的每次更改都会成为可更新代码，应在推送前完成相应检查。

本次新增更新器的代码必须先提交并发布，其他电脑才能通过 Git 下载到这些入口。
已有入口之后，日常更新使用这两个双击文件即可，不必逐台手工执行 Git 与依赖命令。
