# 文档导航

当前版本为 **0.1.0 Preview**。[Windows x64 安装包](https://github.com/Rainbow0328/loopMarshal/releases/tag/v0.1.0)与源代码使用说明以下列指南为准。

## 使用与配置

| 想做什么                                                   | 文档                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 先了解产品，并按界面开始协作                               | [中文 README](README.md#快速开始) / [English README](README-EN.md#quick-start) |
| 第一次使用：逐步配置 Host、加入 Worker、创建会话和检查回报 | [首次协作完整教程](FIRST_COLLABORATION.md)                                     |
| 选择项目、Host、Worker 和知识库维护者                      | [项目、会话成员与知识库](SESSION_WORKSPACE.md)                                 |
| 确认哪些工具能代理，哪些存在条件或限制                     | [Worker 兼容范围](CLI_COMPATIBILITY.md)                                        |
| 设置原工具的模型、Base URL、API Key 与配置目录             | [工具与原生配置管理](NATIVE_TOOL_CONFIG.md)                                    |
| 理解原生会话绑定、名称路由、取消及异常恢复                 | [指定原生会话的工具代理接入](NATIVE_SESSION_PROXY.md)                          |
| 运行、构建或安装 Windows 客户端                            | [Windows 桌面客户端与 EXE 打包](DESKTOP_BUILD.md)                              |

“模型配置”供 Core 执行的模型 Agent 使用；“工具配置”写入第三方工具自己的配置文件。“发现 Worker”负责工具安装登记；已登记工具可以担任 Host、Worker 或知识库维护者。

首次使用建议先看 README 的快速开始，再按完整教程操作。创建按钮不可用、配置后无回应或找不到已有协作时，直接查看教程的 [常见问题](FIRST_COLLABORATION.md#常见问题)。

## 开发与维护

| 内容                                         | 文档                                     |
| -------------------------------------------- | ---------------------------------------- |
| 开发环境、检查命令和增加工具适配             | [贡献指南](CONTRIBUTING.md)              |
| 当前预览版本的变更范围                       | [Changelog](CHANGELOG.md)                |
| README 截图来源及重新生成方式                | [截图说明](assets/screenshots/README.md) |

格式、类型、测试与构建使用 `pnpm run format`、`pnpm run lint`、`pnpm run test`、`pnpm run build`。截图脚本只操作独立临时项目与演示配置，不读取真实模型凭据或调用真实模型。

README 截图使用独立演示数据，只用于展示实际界面。单元测试、受控模型测试和真实模型协作是不同验证层级，各工具的验证范围见兼容表。
