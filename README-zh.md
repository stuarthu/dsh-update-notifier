# dsh-update-notifier

[English](README.md) | 中文

一个 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai) 插件：**每小时检查一次 npm 上已安装 dsh 插件是否有新版本**，发现更新时**弹出一个审批气泡，让你勾选要升级哪些**。勾选后由智能体执行升级；插件自己绝不会擅自升级。

可以把它理解为 dsh 配置内插件版的 [`update-notifier`](https://www.npmjs.com/package/update-notifier)——而且带按钮。

## 工作原理

1. 每小时（可配置）枚举当前配置已加载插件背后的 npm 包，并从配置目录的 `node_modules` 读取各自的已安装版本。
2. 向注册表查询每个包的 `latest` dist-tag（单请求 10 秒超时；失败静默等待下轮重试）。
3. 当 `latest` 严格更新时（完整 semver 比较——正确处理预发布版本，绝不建议降级），对**最近活跃会话的智能体**调用 `ctx.userQuestions.ask()`。dsh 会渲染一个真正的多选提问气泡，每个插件一个选项（`dsh-chrome 0.1.2 -> 0.1.3`）。不占用模型轮次、不消耗 token；断线重连后气泡会重放。
4. 勾选的插件会作为一条后续消息交回给该会话的智能体，指示它执行：

   ```sh
   pnpm --dir <profileDir> add <pkg>@<latest> ...
   ```

   智能体会立即被唤醒，你可以在会话里直接看到升级过程。未勾选的即视为拒绝。

搭配 [`dsh-hot-reload`](https://github.com/stuarthu/dsh-hot-reload) 使用，确认升级后无需重启 dsh 即可生效。

### 什么情况下不会被重复打扰

- **被拒绝**（未勾选）的版本会写入 `<profileDir>/.dsh-update-notifier.json`，**跨重启**永不再提，直到出现更新的版本为止。
- **已批准**的版本不会持久化：升级成功后它自然就是当前版本；升级失败的话，重启后重新提醒才是合理的。
- 你从未回答过的气泡（会话结束、dsh 停止）**不算**拒绝——下次仍会询问。

### 什么情况下弹不出气泡

尚无活跃会话，或所在组合没有 `userQuestions` provider（headless 场景），提醒会挂起：在你下一条消息之后立即重试，下一轮定时检查也会重试。若完全没有 provider，则改为在日志中打印可用更新和现成的升级命令。

## 安装

```sh
dsh plugin --profile web add dsh-update-notifier
```

## 配置

均为可选——见 `cordis.patch.yml`：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `interval` | `3600000` | 检查间隔毫秒数（最小 60000） |
| `initialDelay` | `10000` | 启动后首次检查前的延迟毫秒数 |
| `registry` | `https://registry.npmjs.org` | 要查询的 npm 兼容注册表 |
| `exclude` | `[]` | 永不检查/提及的包名列表 |
| `fetchTimeout` | `10000` | 单个注册表请求超时（毫秒） |
| `profileDir` | 自动探测 | 配置目录的绝对路径 |

插件包可以在自己的 `package.json` 中声明 `"dsh": { "updateNotifier": false }` 主动退出检查。

## 安全说明

- **未经点击不会有任何升级。** 插件从不自行启动包管理器，只负责组装气泡，并在你批准后生成一条由智能体公开执行的指令。
- 气泡和交给智能体的消息中只会出现包名（来自你本地配置）和经语法校验的版本号——注册表的自由文本（描述、变更日志等）不会进入 UI，也不会进入模型上下文。
- 后续消息的 `source.kind` 为 `"plugin"`，明确列出已批准的包，并附带“不得升级列表之外的任何东西”的指示。
- 注册表/网络故障、loader 降级、状态文件不可写、找不到配置目录，均只降级为日志——绝不会让 dsh 崩溃。两个定时器都调用了 `unref`，因此检查器不会拖住进程退出。

## 许可

MIT © Stuart Hu
