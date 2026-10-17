# Codex Desktop Rebuild

Cross-platform Electron build for OpenAI Codex Desktop App.

## Supported Platforms

| Platform | Architecture | Status |
|----------|--------------|--------|
| macOS    | x64, arm64   | ✅     |
| Windows  | x64          | ✅     |
| Linux    | x64, arm64   | ✅     |

## Build

```bash
# Install dependencies
npm install

# Sync upstream resources, then apply all patches
npm run sync
npm run patch

# Build for current platform
npm run build

# Build for specific platform
npm run build:mac-x64
npm run build:mac-arm64
npm run build:win-x64
npm run build:linux-x64
npm run build:linux-arm64

# Build all platforms
npm run build:all
```

## 补丁链路

- `src/<platform>/_asar` 是 ASAR 内资源的补丁目标。
- `src/<platform>/plugins` 与 `src/<platform>/cua_node` 是 Browser / Computer Use 等外置运行时的补丁目标；直打包流程会显式覆盖这两个目录，避免重新复制上游安装包缓存时丢失补丁。
- `patch-browser-auth.js` 兼容 API-key 登录：旧版在 ChatGPT 身份读取失败时仅关闭可选 request-header 并继续本地浏览器通道；新版原生托管请求头不再依赖 ChatGPT 身份时验证该完整链路并保持原样，不会把 API key 伪装或发送为 ChatGPT token。
- `patch-fast-mode.js` 为 API-key / 自定义 Provider 补齐新版 `serviceTierAccess`：跳过不可用的 ChatGPT 账户权限查询，但仍由当前模型返回的 `serviceTierOptions` 决定是否显示和发送 Fast / Ultrafast 档位。
- `patch-provider-quota.js` 按任务实际 Provider 和明确的 `base_url` 判断发送门槛，避免 ChatGPT 额度状态误阻断第三方 Provider，同时保留官方、云任务及第三方真实错误。
- `patch-api-key-home-navigation.js` 补齐 API-key 模式的当前会话导航记录，并识别新版保存在路由 state 中的会话位置；当前会话点击首页保持不变，从设置等页面点击首页则恢复最近会话，避免直达空首页。ChatGPT、无认证及其他认证方式保持原有条件。
- `patch-thread-timeline.js` 在当前 host 与 App Server 版本支持时启用官方 `thread/timeline/list` 历史路径，移除 API-key / 自定义 Provider 无法获得的远端灰度条件；版本兼容判断仍由官方逻辑负责。
- `patch-mcp-status-refresh.js` 将短时间内的 MCP 启动状态通知合并为一次轻量目录刷新；Full 目录只标记为 stale、不在后台立即重拉，详细 MCP 页面后续仍按官方 Full 查询取得资源与模板。
- `patch-remote-control.js` 只开放 Connections 设置入口；需要 ChatGPT 账户与 workspace routing 的 Remote Control 数据链继续遵守官方 gate，避免 API-key 模式反复建立无凭据的 Durable 连接。
- `patch-accent-presets.js` 允许没有 ChatGPT 账户主题的 API-key / 自定义 Provider 在本地选择强调色，并复用官方完整预设渲染消息气泡等界面变量；账户主题仍在加载时保持禁用，账户可用时继续使用官方同步。
- `patch-hide-pet-menu.js` 只隐藏账户菜单中的 Pet / Mini 入口，保留浮动面板实现、状态和全局快捷键。
- `patch-reading-layout.js` 在外观主题卡片中加入 50%–100%、步进 5% 的正文宽度滑杆，并同步代码块、表格和输入区宽度，扩宽适用对话框；百分比不低于官方宽度，Markdown 粗体颜色可跟随正文、强调色或使用自定义颜色。
- `patch-test-isolation.js` 在官方设置 User Data 后、获取单实例锁前挂载 Windows 验收隔离，分别约束 `CODEX_HOME`、User Data 和 sessionData，并记录实际启动路径证据。
- `patch-model-picker-submenu.js` 增加对新版原生 simple / advanced 内联模型列表的结构核验；官方实现完整时保持原样，旧结构继续适配，未知结构明确失败。
- `patch-archive-delete.js` 让归档列表明确查询全部 Provider，避免切换 Provider 后旧归档被隐藏；新版上游已有原生删除链路时保持原样，旧版才补充永久删除入口。
- `patch-updater.js` 区分更新方法与调用 Bundle，并在补丁后核对更新方法确实返回禁用状态；缺少目标或结构未知不再误报为已关闭。
- `sync-upstream.js`、`fetch-msstore.js` 和 `build-from-upstream.js` 强化 Windows x64 官方包选择与固定来源校验，支持精确版本和已验证原始 MSIX 重放；包身份、大小或 SHA-256 不符时拒绝构建，运行检查通过前不生成最终 ZIP。
- `windows-artifacts.js` 与 `windows-maintenance.js` 记录官方来源和候选产物哈希，生成候选、验证发布门槛，并保证正式发布复用已经验收的同一 ZIP。
- `windows-runtime-checks.js` 检查 Windows EXE / 原生模块架构及未修改组件哈希，实际加载 CUA、运行 code-mode host / rg 基础命令，并执行空白隔离桌面的启动、就绪和退出冒烟。
- `check-scripts.js`、`frontend-source-smoke.js`、`reading-layout-smoke.js` 和 `maintenance-smoke.js` 覆盖脚本语法、真实补丁资源、阅读设置及候选/发布拒绝路径，避免只凭补丁脚本成功退出判断功能可用。
- `patch-realtime-voice-auth.js` 为 API-key 登录放行实时语音入口；实时会话仍由 app-server 使用当前 model provider 的 `base_url` 与认证创建，ChatGPT 工作区能力的认证限制保持不变。
- 上游更新后应先执行 `npm run patch -- --check` 或完整 `npm run patch`，再运行测试和构建。

## Development

```bash
npm run dev
```

## Project Structure

```
├── src/
│   └── <platform>/
│       ├── _asar/       # Extracted app.asar patch target
│       ├── plugins/     # Bundled plugin patch target
│       └── cua_node/    # Browser / Computer Use runtime patch target
├── resources/
│   ├── electron.icns    # App icon
│   └── notification.wav # Sound
├── scripts/
│   ├── patch-all.js
│   └── patch-browser-auth.js
├── forge.config.js      # Electron Forge config
└── package.json
```

## CI/CD

GitHub Actions automatically builds on:
- Push to `master` / `main` and tag `v*` → build artifacts
- 每日上游同步工作流：逐平台比较已保存的版本；仅在任一平台版本变化时下载上游、重新应用补丁、构建并更新 Release

### 上游补丁兼容检查

CI 在下载、提取实际上游资源后，先执行 `patch-all.js --check`，通过后再应用补丁和打包。检查与执行报告会写入 Actions 的 Summary；即使补丁失败，也会上传独立的 `Patch-Reports-*` artifact，其中包含 JSON、Markdown 和每个脚本的完整日志。

Summary 只发布正式 CLI 的补丁执行结果；自动测试中的模拟失败仅保留在测试临时目录。程序调用 `runPatches()` 默认不写 CI Summary 或注释，测试调用 CLI 可使用 `--no-ci-output`。

- 认证、运行时、配置传递和功能补丁为必要项，失败会阻止该平台构建和整体发布。
- 版权署名和推理强度中文名称为可选项，失败会保留上游实现并报告警告；实际应用时会恢复该脚本改动前的目标文件，避免打包半完成的修改。
- 补丁等级集中在 `scripts/patch-policy.js` 中；需要全部补丁成功时使用 `--strict`。
- 报告分别统计执行失败、可选补丁警告和待核对项。平台不适用属于正常跳过，扫描提示会合并重复内容；缺少目标标为待核对，不会误报为功能验证通过。
- 检查通过表示脚本没有报执行失败，不代表应用运行、登录或浏览器交互已被验证；待核对项不改变当前构建门槛，仍需确认上游实现是否变化。

```bash
# 先同步上游，再检查兼容性；检查模式不修改资源
node scripts/patch-all.js mac-arm64 --check --report patch-reports/mac-arm64-check

# 应用补丁，再构建
node scripts/patch-all.js mac-arm64 --report patch-reports/mac-arm64-apply
npm run build:mac-arm64

# 调试历史或单独解压的资源，可指定 src 根目录
node scripts/patch-all.js win --check --source-dir /path/to/extracted/src --report patch-reports/win-check
```

## Credits

**© OpenAI · Cometix Space**

- [OpenAI Codex](https://github.com/openai/codex) - Original Codex CLI (Apache-2.0)
- [Cometix Space](https://github.com/Haleclipse) - Cross-platform rebuild & Linux [@cometix/codex](https://www.npmjs.com/package/@cometix/codex) binaries
- [Electron Forge](https://www.electronforge.io/) - Build toolchain

## License

This project rebuilds the Codex Desktop app for cross-platform distribution.
Original Codex CLI by OpenAI is licensed under Apache-2.0.
