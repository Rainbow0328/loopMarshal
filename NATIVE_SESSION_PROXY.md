# 指定原生会话的工具代理接入

本文说明 0.1.0 开发版的原生会话代理，运行于同一 Core、CLI/MCP 和桌面/浏览器工作台。已提供 PATH/常见目录发现及独立 [工具配置](NATIVE_TOOL_CONFIG.md) 页面，首次操作见 [快速开始](README.md#快速开始)。Windows 构建方法见 [桌面构建](DESKTOP_BUILD.md)。注册表/快捷方式发现、PTY 和工作区隔离尚未实现。

## 已实现的行为

Core 集中记录协作会话中的成员名称、角色、接入方式。代理成员另外绑定工具安装、项目目录、工具数据目录和原生会话关系：默认由 LoopMarshal 在首次派发时创建会话并保存实际 ID，也可以明确接续已有 ID。等待式成员不需要填写工具或原生 ID。

Host 继续执行原来的命令：

```powershell
loopmarshal dispatch-many 主控 --session test --task '前端开发::实现登录页面'
```

Core 将 `test / 前端开发` 解析成成员 ID，再按登记的路由投递。首次派发可创建并登记原生会话，之后始终接续同一个会话；显式选择已有会话时也始终使用指定 ID。结果定向回到原发送成员，并关联原任务。不会选择最近会话、静默替换会话或自动 fork。原 MCP `dispatch_many` 和等待链继续使用原参数。

代理 Worker 空闲时不运行 await 进程。Host 原有的等待及后续处理协议保留。收到代理回报表示一轮执行结束，仍由 Host 验收代码与任务结果。

## 工具支持与验证记录

当前合计 11 种适配，包括 Gemini CLI、Kimi Code CLI 2.x、Cursor CLI、Factory Droid 和 GitHub Copilot CLI。扫描和选择时显示可用状态；不可用项展示具体原因和处理办法。“可用”不是全部真实模型能力验收通过。当前版本、条件与证据以 [Worker 兼容范围](CLI_COMPATIBILITY.md) 为准，下面是首轮历史记录，不覆盖后续 Codex/Claude/MiMo 的真实协作记录。

截至 2026-11-09：

| 工具 ID    | 绑定验证与调用方式                                                                                  | 本次验证证据                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `codex`    | 检查 CODEX_HOME 中的 session_meta ID/cwd；`exec resume <id> --json -`                               | Windows Codex CLI 0.153.4：真实模型、多轮历史接续、Core 重启后接续通过                                      |
| `claude`   | 检查 CLAUDE_CONFIG_DIR/projects 中的 sessionId/cwd；`--print --resume <id>`                         | 官方 2.1.278 ＋本地测试模型服务：四轮、双会话历史、重启和无效 ID 拒绝通过；真实账号服务待验收               |
| `qwen`     | 检查指定 QWEN_HOME / QWEN_RUNTIME_DIR 中的会话记录；`--resume <id> --prompt`                        | 官方 0.27.0 显式配置 `--bare` ＋本地测试模型服务：四轮、双历史、重启和无效 ID 拒绝通过；真实模型待验收      |
| `zcode`    | 只读核对 session 表 ID/directory；指定配置环境与 ZCODE_SESSION_DB_PATH，再 `--resume <id> --prompt` | 官方源码 a9fe401 构建的 CLI 0.17.1 ＋本地测试模型服务：四轮、双历史、重启和无效 ID 拒绝通过；真实模型待验收 |
| `mimo`     | 显式绑定 MiMo 服务地址；查询及发送 `/session/<id>` API，并核对占用状态                              | 官方 MiMo Code 0.1.9 ＋本地测试模型服务：四轮、双历史、重启和无效 ID 拒绝通过；真实模型待验收               |
| `opencode` | 显式绑定 OpenCode 服务地址；查询及发送 `/session/<id>` API，并核对占用状态                          | 官方 1.19.5 ＋本地测试模型服务：四轮、双历史、重启和无效 ID 拒绝通过；真实模型待验收                        |

以上五款运行了真正的厂商程序与原生存储，由本地模型服务检查恢复历史中的随机标记。它比替身进程的契约测试多覆盖了厂商实际行为，仍不能代替真实模型、账号及实际编码任务验收。各工具当前支持范围与限制见 [兼容表](CLI_COMPATIBILITY.md)。

Qwen 0.27.0 默认启动在本机两版 Node 24 上均出现输出成功后退出崩溃；`--bare` 路径通过。需要在安装登记的固定启动参数中显式加入 `--bare`。该模式跳过隐式启动发现，需保留必要的显式模型配置；本实现不会自动对其他安装开启它。

MiMo/OpenCode 必须先使用厂商命令启动对应的会话服务，再填写地址；本版本不自动启动或管理这些常驻服务。ZCode 请选择实际可执行文件或构建产物 `zcode.cjs`，不猜测未验证的 npm 启动器。

## 使用流程

先按 [快速开始](README.md#快速开始) 启动客户端或浏览器工作台。可直接“新建协作”选择代理 Host 和成员，也可打开已有协作，点击顶部 **查看绑定**，进入“成员绑定与接入”：

1. 先在 **发现 Worker** 登记工具的可执行文件，再在会话成员设置中选择该安装；原生模型、地址和密钥在独立 **工具配置** 页维护。
2. 填写成员名称、职责、项目目录和工具数据目录。默认选择“新建原生会话”，不填写会话 ID；需要继续历史时选择“接入已有原生会话”再填写准确 ID。MiMo/OpenCode 额外填写服务地址。
3. 新建模式会显示“等待首次消息”，发送第一条任务后 LoopMarshal 才创建并记录原生会话；已有会话模式需先停止其他窗口的执行，再点击 **验证会话**。MiMo/OpenCode 需先启动对应服务。
4. 已有会话验证通过后，Host 就可以按成员名称派发任务；新建模式无需预先验证原生会话。

验证动作只检查工具版本、已保存的会话身份及工作目录，或查询服务端会话，不发送模型测试消息。已有会话在接入时检查一次，新建会话在创建后记录验证结果。后续投递直接接续绑定 ID，不反复探测版本或使用心跳判断托管工具是否在线。执行进程启动失败、意外中断、服务不可达或返回错误会记录在投递中并显示异常；结果不确定时仍需人工核对。更换工具或会话绑定后需要重新检查。

CLI 等价操作（路径和 ID 请替换成自己的值）：

```powershell
loopmarshal attach 主控 --session test --role host --duty '理解需求并协调执行'
loopmarshal tool add --tool codex --path 'C:\Tools\codex.ps1' --name '本机 Codex'
loopmarshal tool list
loopmarshal member add 前端开发 --session test --installation '<安装ID>' --native-session '<原生ID>' --workspace 'D:\Projects\A' --namespace 'D:\AgentData\codex' --duty '前端实现'
loopmarshal member verify 前端开发 --session test
loopmarshal member list --session test
loopmarshal dispatch-many 主控 --session test --task '前端开发::实现登录页面'
loopmarshal delivery list --session test
```

工具数据目录必须是该原生会话实际所属的配置/运行环境。常见位置是 Codex 的 CODEX_HOME、Claude 的 CLAUDE_CONFIG_DIR、Qwen 的配置及运行数据根目录（首版要求二者相同）。ZCode 填实际 `.zcode` 目录或其父级用户目录，统一定位 `.zcode/cli/db/db.sqlite`，并同步选择个人模型配置、凭据及 CLI 运行配置；不会猜测最近数据库。

ZCode 默认显式使用 `build` 常规审批模式，避免厂商 `--prompt` 缺省的 `yolo`。可在工作台或 `member add/bind --zcode-mode <模式>` 选择 `plan / build / edit / guarded / yolo`；遇到需要审批的操作可能阻塞，需要处理权限或转用等待式接入。

若厂商需要环境变量中的模型配置，添加安装时可选择允许继承的变量名，或用 `tool add --environment-keys OPENAI_API_KEY,OPENAI_BASE_URL,OPENAI_MODEL`。数据库只存名称，执行时从 Core 的环境读取；缺失时明确阻塞。不会继承 Core 管理凭证或所有模型密钥。固定启动参数可用 `--arg` 登记；禁止在其中指定原生会话或填写密钥。

绑定是持久记录。退出 CLI、关闭页面或重启 Core 不会删除它。普通 attach 重连不会覆盖已登记的代理绑定。

## 调整成员

页面可以调整接入、停用或重新启用成员。对应命令：

```powershell
loopmarshal member disable 前端开发 --session test --reason '暂不参与本轮'
loopmarshal member enable 前端开发 --session test --reason '继续参与'
loopmarshal member bind 前端开发 --session test --installation '<安装ID>' --native-session '<另一个已有ID>' --workspace 'D:\Projects\A' --namespace 'D:\AgentData\codex' --reason '更换目标会话'
loopmarshal member use-await 前端开发 --session test --mode mcp_await --reason '改用原等待链'
```

有待处理消息或未解决投递时拒绝改绑、切换与删除，避免任务发到新目标。先处理或取消旧任务。启用或改绑代理后需要重新验证；等待成员的原生工具字段会清空。

## 新增名称发送入口

`send` 支持 `task / task_report / question / answer / announcement`，内容为 JSON：

```powershell
loopmarshal send --session test --from 主控 --to 前端开发 --type task --content '{"content":"实现登录页面"}' --idempotency-key login-1
```

多个名称用逗号分隔，`--to all` 展开本轮收件人。重试须使用同一个幂等键与相同内容；已固定的收件人不会因新成员加入而增加。实现任务只允许 Host 发给 Worker。代理只因 task、question、answer 启动一轮；公告和回报作为信息记录，不自动触发代理。

## 队列、取消与恢复

- 消息和代理投递在同一 SQLite 事务中保存。每个原生会话串行执行，全局最多同时执行 4 个任务。
- 同一份数据只允许一个 Core 持有执行权。旧 Core 进程无法确认停止时拒绝接管，不以超时推断旧执行者已经消失。
- 重启时原先执行中的任务标为 `unknown` 并向 Host 发送诊断回报，保留该原生会话的执行锁，不自动重复执行。
- 取消未开始的投递可直接完成；取消正在执行的任务会请求停止子进程树或厂商服务。已经产生的副作用需要核对，执行状态记为待核对。
- 工作台可查看事件并记录人工核对结论；也可以使用下面的命令。核对操作只记录结果，不重发任务。

```powershell
loopmarshal delivery events '<投递ID>'
loopmarshal delivery cancel '<投递ID>'
loopmarshal delivery reconcile '<投递ID>' --outcome failed --summary '已确认原执行停止，检查过会话历史和文件改动，任务未完成' --confirmed-stopped
```

若已找到任务结果，使用 `--outcome reported`，把结果写入 summary 交由 Host 验收。

## 运行边界

此版本默认由 LoopMarshal 在第一次任务到来时创建并记录新的原生会话，再按成员路由持续接续其历史；也支持明确绑定已有原生会话。不向任意已打开的外部终端注入按键。Core 内的任务有串行保护；尚不能检测所有工具的外部写入者，因此代理必须接管已停止外部写入的会话。不要从另一个窗口同时操作它。

不同原生会话可能同时修改同一项目。此阶段没有提供 worktree 或文件写入隔离，应由 Host 安排职责和修改范围。工具沿用自己的权限配置；ZCode 例外为显式的绑定模式，默认要求审批。不会自动启用跳过批准选项。

本版本使用本机管理凭证保护工具管理、代理派发和投递处理接口。Web 从同源本机 Core 获取，CLI 从对应数据库的 `.management-token` 旁文件读取。服务端校验摘要，客户端旁文件保存凭证以便本机使用；需要撤销管理凭证时停止 Core，替换旁文件并重启。使用自定义数据库时，CLI 也需要相同的 `LOOPMARSHAL_DATABASE_PATH`。

可通过工作台或 `member credential issue/list/revoke` 签发、查看及撤销成员发送凭证。服务端只存 SHA-256 摘要，明文仅签发时显示；使用 `Authorization: Bearer <凭证>` 调用发送接口，或设置 CLI 的 `LOOPMARSHAL_MEMBER_TOKEN`。凭证只能以对应 session/agent 身份发送，不能管理路由、查询其他数据或调用非发送 MCP 工具；无效/已撤销凭证不会降级使用管理员身份。代理结果由 Core 自动回报，不向编程工具注入管理凭证。

旧等待链的无令牌兼容接口限于同源、本机环回请求。当前仍是受信任的本机协作模式，不提供远程多租户隔离。管理旁文件、模型配置和备份不应提交。

旧数据库升级前自动在原路径旁生成 `.pre-migration-*.bak` 一致性备份；正常重启不重复备份。需降级程序时，停止 Core 后恢复升级前备份，不能直接让旧程序操作新版数据。

本地会话核验有扫描和读取上限，遇到未知格式或超限会明确阻塞。事件接口有分页；页面展示最近事件，完整检查可使用 SDK 的 `getDeliveryEvents(id, after)`。没有 PTY 或进程重新附着；Core 崩溃后可能残留的工具执行必须核对。

## 验证方式

```powershell
pnpm run build
pnpm run lint
pnpm --filter @loopmarshal/core test
pnpm --filter @loopmarshal/store test
node scripts/smoke-proxy-routing.mjs
node scripts/smoke-member-credentials.mjs
```

代理集成测试检查原 Host 命令、混合等待链、两份原生历史的精确投递、重启保留绑定、管理鉴权、双 Core 互斥，以及无需 await 进程的代理空闲判断。

`scripts/verify-native-proxy.mjs` 可在明确的两份测试原生会话上验证真实模型：提供 `--tool`、`--executable`、`--workspace`、`--namespace`、`--session-one`、`--session-two`、`--marker`；服务型工具还需 `--endpoint`。marker 必须预先写在第一个原生会话的历史里，脚本提示不会包含它。`--session-two-file` 校验第二份历史在未被寻址时未变化，`--marker-two` 继续向第二份历史验证第四轮。可用 `--args-json` 和 `--environment-keys` 显式选择启动环境。脚本重启一次临时 Core，不应传入正在工作的原生会话。

`scripts/verify-native-server.mjs --tool <claude|qwen|mimo|opencode|zcode> --executable <路径> --keep` 在独立临时目录运行厂商程序＋本地模型服务，创建两份测试会话，验证四轮和重启、错误 ID。Qwen 追加 `--bare`。该脚本目前面向 Windows，会停止自己启动的服务进程；`--keep` 保留原生记录、临时 Core 数据及 evidence.json 供复查。

接口参考：[Codex CLI](https://developers.openai.com/codex/cli/reference/)、[Claude Code](https://code.claude.com/docs/en/headless)、[Qwen Code](https://github.com/QwenLM/qwen-code)、[ZCode](https://github.com/zai-org/zcode/tree/main/apps/zcode-cli/docs/usage)、[MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code)、[OpenCode Server](https://opencode.ai/docs/server/)。
