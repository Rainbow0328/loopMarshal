# Windows 桌面客户端与 EXE 打包

当前 **0.1.0 Preview** 的 Windows x64 安装包在 [GitHub Releases](https://github.com/Rainbow0328/loopMarshal/releases/tag/v0.1.0) 提供。仓库支持构建 Windows x64 的 Electron 客户端和 NSIS 安装器，安装器包含工作台、Core、生产依赖及固定版本的 Node.js 运行时，使用者无需安装 Node、npm 或 pnpm。第三方编程工具需自行安装和认证，再在“发现 Worker”中登记，在独立“工具配置”页管理原生配置。首次使用见 [带截图的快速开始](README.md#快速开始)。

## 一键打包

开发机需要 Windows x64、Node.js 24、pnpm 10.10.0，以及首次下载 Electron、Node 运行时和安装器组件所需的网络连接。

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm run desktop:dist
```

输出：

- `release/desktop/LoopMarshal-Setup-0.1.0-x64.exe`：可分发的安装器。
- `release/desktop/win-unpacked/LoopMarshal.exe`：解压版程序；应保留整个 `win-unpacked` 目录。

桌面打包始终使用 `release/desktop`，重复打包直接覆盖该目录中的输出，不另建批次或备份目录。安装器构建成功后自动删除该目录中过时版本的安装包、配套文件与验收汇总，只保留当前版本。`release/loopmarshal` 是独立的命令行 npm 包输出，不属于桌面安装包。

其他命令：

```powershell
pnpm run desktop:dev       # 构建资源并打开开发版桌面窗口
pnpm run desktop:unpacked  # 只生成解压版
pnpm run desktop:test      # 桌面后台进程管理测试
```

打包命令会先构建前端和 Core，再部署锁定版本的生产依赖。首次调用时会自动补充缺失的 Electron 二进制文件。Node 运行时下载自官方发行地址，并按固定 SHA-256 校验后只提取运行程序和许可文件。

当前固定 Electron 45.2.3、Node.js 24.14.0、electron-builder 26.18.0，仅支持 Windows x64。当前构建关闭了代码签名，Windows 可能显示未知发布者提示；正式签名分发需另行提供证书并启用签名配置。

如果当前网络无法下载 GitHub 上的 Electron 或安装器组件，可以在本次 PowerShell 窗口设置镜像后重试：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
pnpm run desktop:dist
```

## 安装与运行

安装器默认按当前用户安装，可选择安装目录，创建桌面、开始菜单入口和卸载入口。安装结束后从快捷方式打开 LoopMarshal。

客户端启动时自动运行自己的 Core，仅监听 `127.0.0.1`，默认端口 `42688`。如果已有 Core 占用该端口，会显示启动失败和日志位置；应先停止旧 Core 再打开客户端。重复打开客户端会切回已有窗口。

关闭客户端会停止它启动的 Core，并停止由它执行的本地代理进程。执行中断后不能确认完成的任务会保留待核对状态，避免自动重复执行。外部工具服务及其已有会话仍由原工具管理。

首次使用在左侧“发现 Worker”扫描或手动登记工具。进入独立“工具配置”页，选择工具和实际配置目录，编辑已适配的模型、地址及认证字段；“保存修改”显示预览，“确认写入”才写回原工具文件并保留备份。已有进程是否需要重启取决于原工具，界面会提示生效范围。供 Core 执行 Agent 的模型连接在“模型配置”中另外维护。

“新建协作”必须选择项目目录并配置唯一 Host，可选 Worker 和知识库维护者，混用模型 Agent、CLI 原生会话代理和 IDE/MCP 成员。新建代理会话不要求已有 ID，首条任务到来时自动创建并登记编号。主对话只显示用户与 Host 的交流；成员目录、对话历史、进展和实时动态分别打开，知识库按会话保存。具体流程见 [项目、会话成员与知识库](SESSION_WORKSPACE.md)。

基础协作 Skill、工具入口和成员身份在创建时自动准备，无需手动选择。成员配置由客户端独立保存、随服务重启更新，不覆盖编程工具的全局配置。原工具模型配置通过“工具配置”按预览写回厂商目录，这是与会话成员身份分开的两类配置。

## 用户数据与升级

默认数据目录为 `%LOCALAPPDATA%\loopmarshal`：

| 位置                             | 内容                                                    |
| -------------------------------- | ------------------------------------------------------- |
| `loopmarshal.sqlite`             | 协作会话、成员路由、工具清单、配置档案和消息投递记录    |
| `native-config-backups`          | 原生工具配置备份                                        |
| `agent-setups`                   | 按会话和成员管理的协作 Skill、MCP、工具桥与私有连接配置 |
| `knowledge/sessions/<sessionId>` | 各会话独立的知识文件与历史                              |
| `user-preferences.json`          | 用户偏好                                                |
| `logs`                           | 桌面与 Core 日志                                        |
| `desktop/chromium`               | 桌面浏览器状态                                          |
| `desktop/endpoint.json`          | 运行中的桌面 Core 地址，正常退出时移除                  |

升级安装复用该目录；卸载保留用户数据。编程工具自己的配置和会话目录不会搬进安装目录。客户端已经移除应用菜单栏，需要查看数据或日志时可在资源管理器打开上述路径；启动失败的提示也会给出日志位置。

测试时可设置 `LOOPMARSHAL_DESKTOP_DATA_DIR` 指向独立数据目录；`LOOPMARSHAL_DESKTOP_PORT=0` 可使用临时空闲端口。日常使用无需设置。

## Host 的命令入口

开始菜单的“LoopMarshal 命令行”打开随包命令入口；也可直接使用下面的安装路径。该入口使用随包 Node，自动连接正在运行的桌面 Core，不需要全局 Node 或 CLI 安装。客户端没有应用菜单栏，不依赖“复制命令入口路径”菜单。

```powershell
& '实际安装目录\resources\loopmarshal\bin\loopmarshal.cmd' --help
& '实际安装目录\resources\loopmarshal\bin\loopmarshal.cmd' status
& '实际安装目录\resources\loopmarshal\bin\loopmarshal.cmd' member list --session test
```

Host 继续使用 `send --session ... --from ... --to ...` 等既有命令。入口只改变程序启动位置；成员名称、会话寻址及 MCP/CLI 兼容逻辑由同一 Core 处理。该入口不修改系统 PATH。

Host 可用 `messages <Host成员名> --session <会话名> --member <成员名>` 只读查询协作历史；MCP 对应 `query_messages`。客户端对话会发送给当前 Host，等待型外部 Host 仍需领取；通过 `resolve --summary ...` 处理客户端输入时，摘要会自动显示在客户端聊天中。

需要先打开客户端。桌面入口禁用 `start` 和 `stop`，由窗口统一管理服务生命周期。第三方 CLI 原本的安装方式、账号及登录状态仍由其自身管理。

外部 IDE / CLI 可以使用此入口 `attach <成员名> --session <会话名> --role host --duty <职责>` 创建会话并担任 Host，默认登记命令执行目录，也可加 `--project <完整项目目录>`。MCP `attach` / `resume` 可传 `projectPath`。点击左上会话名称，在会话列表顶部“打开已有协作”按项目查找；外部工具需连接同一 Core。客户端新建表单的 Host 必须选择模型连接或代理工具，其他成员按需添加。

## 自动验收

桌面进程管理测试已纳入 `pnpm run test`。桌面整体检查可使用已有的 Playwright 安装，无需将其加入生产依赖：

```powershell
node scripts/smoke-desktop.mjs --playwright '完整路径\playwright-core\index.mjs'
# 也可以指定安装后的程序：
node scripts/smoke-desktop.mjs --playwright '完整路径\playwright-core\index.mjs' --executable '安装目录\LoopMarshal.exe'
```

脚本在独立临时目录中运行，移除系统 Node/npm 路径，检查窗口隔离、SQLite、代理执行使用随包运行时、配置写回/备份恢复、重启持久化、重复启动、CLI 入口和退出清理。结果、截图及测试数据目录保留供复查。

可选真实 Codex 验收仅使用明确指定的专用测试会话，额外提供 `--codex-executable`、`--codex-workspace`、`--codex-namespace`、`--codex-session`、`--codex-marker` 和 `--other-session-file`。脚本通过随包 CLI 按成员名称发送一条不含历史标记的提示，核对真实模型读到了指定历史，并校验未寻址会话文件未改变。其余工具的真实模型验收仍按各自账号准备情况进行。

GitHub Actions 的 **Windows Desktop Package** 工作流支持手动构建并下载安装器构件，不自动发布 Release。

## 运行观察窗口

协作页顶部“实时动态”仅记录打开后出现的新协作活动。当前执行中的“查看运行”可将观察窗口独立置前；成员页也为执行中的代理成员提供该入口。它连接现有 Core，只读查看同一任务，不额外调用模型，也不会启动第二个工具进程。关闭观察窗口后原任务继续；关闭整个客户端仍按原生命周期停止其后台服务。

观察窗口中的“查看对话历史”会打开主窗口对应会话，并按成员筛选。完整历史始终保留在原消息列表中。后台代理没有原生终端窗口，本入口展示工具提供的执行活动与回报，不是 CLI 原生交互界面。

Windows 客户端的标题栏现与导航和页面相连，顶部空白处可以拖动，系统窗口按钮仍支持最小化、最大化、还原和关闭。标题栏颜色随本窗口主题更新。协作页点击左上当前会话名称可展开固定高度的会话列表，刷新和“打开已有协作”在该列表顶部。

当前为预览版本，桌面客户端与项目版本统一为 **0.1.0**，默认安装包为 `release/desktop/LoopMarshal-Setup-0.1.0-x64.exe`。开发期反复打包保持此版本，仅覆盖 `release/desktop`。安装前退出旧客户端，再从安装后的快捷方式启动。

桌面及开始菜单快捷方式引用 `resources/loopmarshal-icon-<图标内容摘要>.ico`，与应用内图标一致。图标变化即更新路径，无需递增产品版本。覆盖安装时刷新已有快捷方式和 Windows 图标缓存，避免继续使用旧图标。仅生成安装包不会改变已经安装的程序，需要运行安装包完成更新。

图标母版为 `apps/web/public/loopmarshal.png`，应用内品牌和网页图标使用相同文件；桌面准备阶段自动生成窗口 PNG 和九种 Windows ICO 尺寸。当前使用选定的 V8-B 图标母版，常规打包无需设计工具。

桌面验收可以直接提取安装包内的程序，并比对程序、应用资源与网页构建资源，检查版本、标题栏、会话切换入口和布局。`release/desktop/acceptance-0.1.0.json` 若存在，仅对应其记录的那一次构建；修改源码、文档或 README 截图不会自动更新安装包或该验收记录。公开预览包附有 SHA-256 校验文件，构建与源代码版本以 Release 说明为准。
