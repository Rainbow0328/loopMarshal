# 快速开始截图

这些 PNG 来自当前代码构建的浏览器工作台，桌面客户端复用同一套前端。页面使用真实 Core 和产品接口，数据来自隔离的商品管理台演示项目。工具进程使用受控响应，不调用真实模型，不扫描真实安装，不修改用户配置。

| 文件                           | 展示内容                                       |
| ------------------------------ | ---------------------------------------------- |
| `quick-start-config.png`       | 独立工具配置页、Codex 模型、地址和环境变量认证 |
| `quick-start-create.png`       | 项目和 Host 必填，选择本机工具新建原生会话     |
| `quick-start-worker.png`       | 添加执行者后选择工具、名称、职责和独立原生会话 |
| `quick-start-conversation.png` | 用户与 Host 的主对话                           |
| `quick-start-activity.png`     | 打开后新增的成员协作动态                       |
| `quick-start-knowledge.png`    | 当前会话的知识目录与文档                       |

截图中的工具名、模型名、服务地址和会话内容均为演示数据。`api.example.com` 不是真实可用的模型地址，不应照抄。所有路径均指向临时演示目录。截图不代表这些演示任务已由真实 AI 自主完成，也不代表桌面安装包已重新构建。

## 重新生成

先从仓库根目录构建：

```powershell
pnpm run build
```

使用已有 Playwright Node 包及其 Chromium/Chrome，无需向生产依赖加入浏览器工具：

```powershell
node scripts/capture-docs.mjs --playwright '完整路径/playwright/index.mjs' --browser '完整路径/chrome.exe'
```

`--playwright` 指向可导入且导出 `chromium` 的 Playwright 或 playwright-core 入口，`--browser` 指向浏览器可执行文件。默认覆盖本目录下的六张同名 PNG；可传 `--output <目录>` 改变输出位置。脚本结束时关闭浏览器、Core 和演示工具进程，清理临时数据。

截图使用 1440px 宽度、浅色主题和减少动态效果；创建表单使用稍高窗口，以同时呈现项目与 Host 字段。Worker 截图滚动到执行者卡片；脚本还会配置维护者并检查创建按钮可用。更新文案或布局后应重新生成，不直接修图伪造界面。图片使用仓库相对路径，供中英文 README 和首次协作教程共用。
