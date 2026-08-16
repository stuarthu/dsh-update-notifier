# dsh-update-notifier

[English](README.md) | 中文

一个 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai) 插件：**每小时到 npm 查询一次你已安装的 dsh 插件有无新版本**，发现更新时**弹出一个审批气泡，让你勾选要升级哪些**。勾选后由智能体执行升级；插件自己绝不会擅自升级。

可以把它理解为 dsh profile 内插件版的 [`update-notifier`](https://www.npmjs.com/package/update-notifier)——而且带按钮。

## 工作原理

1. 每小时（可配置）枚举当前 profile 已加载插件背后的 npm 包，并从 profile 目录的 `node_modules` 读取各自的已安装版本。若某个插件在那里没有可读取的包（从本地检出 link 过来的，或 dsh 内置的），则静默跳过。
2. 向注册表查询每个包的 `latest` dist-tag（单请求 10 秒超时；失败时静默跳过，下一轮重试）。
3. 当 `latest` 严格更新时，对**最近活跃会话的智能体**调用 `userQuestions.ask()`。dsh 会渲染一个真正的多选提问气泡，每个插件一个选项（`dsh-chrome 0.1.2 -> 0.1.3`）。不占用模型轮次、不消耗 token；断线重连后气泡会重放。版本比较严格遵循 semver——预发布版本排序正确，绝不建议降级；不符合严格 `X.Y.Z` 格式的版本会被跳过，而不是猜测其含义。
4. 勾选的插件会作为一条后续消息交回给该会话的智能体，指示它执行：

   ```sh
   pnpm --dir <profileDir> add <pkg>@<latest> ...
   ```

   智能体会立即被唤醒，你可以在会话里直接看到升级过程。未勾选的即视为拒绝。

搭配 [`dsh-hot-reload`](https://github.com/stuarthu/dsh-hot-reload) 使用，确认升级后无需重启 dsh 即可生效。

### 什么情况下不会被重复打扰

- **被拒绝**（未勾选）的版本会写入 `<profileDir>/.dsh-update-notifier.json`，**跨重启**永不再提，直到注册表的 `latest` 变成另一个仍然高于你已安装版本的版本为止。
- **已批准**的版本不会持久化：升级成功后它自然就是当前版本；升级失败的话，重启后重新提醒才是合理的。
- 你从未回答过的气泡（会话结束、dsh 停止）**不算**拒绝——下次仍会询问。
- 同一时间只会有一个气泡。在它等待回答期间，定时检查会跳过；这期间发布的新版本，会在你回答之后的第一轮检查中被发现。

### 什么情况下弹不出气泡

尚无活跃会话，或所在组合没有 `userQuestions` provider（headless 场景），提醒会挂起：在你下一条消息之后立即重试，下一轮定时检查也会重试。若完全没有 provider，则改为在日志中打印可用更新和确切的升级命令。

## 安装

```sh
dsh plugin --profile web add dsh-update-notifier
```

需要 Node 18+（依赖全局 `fetch`）——任何 dsh 宿主都已满足。

## 配置

均为可选——见 `cordis.patch.yml`：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `interval` | `3600000` | 检查间隔毫秒数（最小 60000） |
| `initialDelay` | `10000` | 启动后首次检查前的延迟毫秒数 |
| `registry` | `https://registry.npmjs.org` | 要查询的 npm 兼容注册表 |
| `exclude` | `[]` | 永不检查/提及的包名列表 |
| `fetchTimeout` | `10000` | 单个注册表请求超时（毫秒，最小 1000） |
| `profileDir` | 自动探测 | profile 目录的绝对路径；探测失败时插件会告警并保持停用 |

插件包可以在自己的 `package.json` 中声明 `"dsh": { "updateNotifier": false }` 主动退出检查。

## 安全说明

- **未经点击不会有任何升级。** 插件从不自行启动包管理器，只负责组装气泡，并在你批准后生成一条由智能体在你眼前执行的指令。
- 气泡和交给智能体的消息中只会出现包名（来自你本地 profile）以及来自注册表、经语法校验的版本号——注册表的自由文本（描述、变更日志等）不会进入 UI，也不会进入模型上下文。
- 后续消息的 `source.kind` 为 `"plugin"`，明确列出已批准的包，并明确指示不得改动列表之外的任何内容。
- 注册表/网络故障、loader 状态异常、状态文件不可写，均只降级为日志——绝不会让 dsh 崩溃。唯一会让插件直接停用的情况是定位不到 profile 目录，此时会打印明确的告警。两个定时器都调用了 `unref`，因此检查器不会拖住进程退出。

## 许可证

MIT © Stuart Hu
