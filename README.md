# TabRelay

**多设备标签接力，不覆盖本机工作区。** Chrome Manifest V3 扩展，使用自己的 WebDAV 保存设备独立快照。以侧边栏浏览另一台设备的窗口、标签和当前打开的标签组；确认后在本机新增窗口，随后回传合并后的实际工作区。

## 能做什么

- 自动采集普通窗口：URL、标题、顺序、置顶、活动标签、已打开标签组的名称/颜色/折叠状态。
- 每个浏览器 Profile 一个独立设备 UUID；不同设备分别发布，互不覆盖。
- 全窗口、单窗口、标签组或单标签恢复；预检后确认；原窗口不关闭。
- 来源标识去重防止 A → B → A 回环；相同 URL、不同来源默认保留。
- 持久化待发布快照和恢复日志；取消保留已创建窗口；安全条件满足时撤销。
- 最近有效非空恢复点、可配置历史保留；断网重试、认证错误、ETag 冲突显示。
- 域名黑名单、敏感查询参数移除、可选 AES-256-GCM 快照加密。

不包含 Cookie、登录状态、表单、滚动、页面内存、前进后退历史、未打开的“已保存标签组”；不做远端标签自动打开或多主实时协同。

## 构建与安装

需要 Node.js 22+，Chrome/Chromium 120+。

```sh
npm ci
npm run check
```

在 Chrome 扩展管理页启用开发者模式，加载项目的 `dist/` 目录。工具栏打开 TabRelay 侧边栏，也可从 Popup 打开独立管理页。

1. 设置设备名称、**HTTPS WebDAV 基础目录**、账号和应用专用密码。基础目录必须已经存在。
2. 授权该 WebDAV origin，开启自动同步。扩展只在用户点击保存/测试时请求该主机权限。
3. 同一 WebDAV 目录配置到另一台设备。若启用加密，所有设备填写相同加密口令。
4. 从设备列表选择快照和标签，点击预检，核对数量后确认恢复。

WebDAV 服务必须支持 `PROPFIND Depth: 1`、`MKCOL`、`GET`、`PUT`、`DELETE`、**强 ETag 和条件 PUT**。不支持强 ETag 的服务会明确拒绝更新，不会降级成不安全覆盖。目录/反向代理必须保留这些方法和 `If-Match`/`If-None-Match`。

## 安全与数据说明

- 生产构建只接受 HTTPS。重定向不跟随；凭据只发送给本机明确配置的 origin 和目录。
- URL 可能包含敏感信息。默认移除 `access_token/token/auth/code/password/secret/session` 查询参数，可自行配置；**无法保证识别所有敏感参数**。不要将不该离开本机的域名同步到服务器。
- 无痕窗口不采集。只恢复 http/https，不恢复内嵌凭据、javascript/data/blob/file/chrome/其他扩展地址。
- 设置和加密口令保存在扩展本机 storage.local，仅受信任扩展上下文可访问；不使用 content script、Cookie、history 或 scripting 权限。浏览器 Profile 被攻陷时，本机凭据与解锁口令不受保护。
- 加密使用随机 salt/IV、PBKDF2-SHA256 210,000 次派生及 AES-GCM；设备名称、数量和同步时间仍是明文。首次成功发布后，不支持在同一目录直接改加密口令，请使用新目录。旧快照仍需旧口令读取。
- 默认最多恢复 30 个窗口、1,500 个标签、500 个组、5 MB JSON。大批量恢复会消耗内存，先选择小范围。
- 冲突会暂停同步并要求检查 Profile 克隆或生成新的设备 ID。生成新 ID 不会删除旧设备远端文件。

## 恢复与重启边界

Chrome 没有跨窗口原子事务。TabRelay 在每次创建前持久化意图、创建后记录实际 ID。若中断恰好发生在两者之间，结果不确定时**不盲目重做**，提示保留当前结果、停止任务并检查。完整浏览器重启可能重新分配运行时 ID，此时拒绝自动续做/撤销旧任务；同一浏览器会话内的 Service Worker 重启可核对已记录进度后继续。

撤销仅针对本次创建、成员与 URL 未变化的窗口，并在每次关闭前复核。浏览器没有原子的“条件关闭”API，因此仍不能保证与用户在完全相同瞬间编辑窗口严格隔离；不确定时拒绝自动关闭。取消则只停止后续创建，已有窗口永远保留。

逻辑 ID 跨完整重启采用 URL、位置、窗口关系尽力重关联；完全相同 URL/位置的歧义无法绝对消除。此限制不会触发删除原有窗口。

## 设计与验证

- [原始需求](docs/specification.md)
- [工程设计与安全取舍](docs/architecture.md)
- [验收与证据说明](docs/verification.md)
- [GitHub Actions](../../actions)

```sh
npm run typecheck
npm test                 # 模拟 Chrome API / fetch 的单元与故障测试
npm run build            # 严格 HTTPS 的生产扩展
npx playwright install --with-deps chromium
npm run test:e2e          # 两个真实 Chromium Profile + 本机 DAV 测试服务
```

真实浏览器 E2E 使用单独 `dist-test/`，只增加 loopback HTTP 测试传输及固定 loopback 主机许可；不忽略 TLS 证书警告、不访问用户数据。生产 `dist/` 不包含此例外。E2E 生成截图与 JSON 结果到 `evidence/`；CI 上传为 `verification-evidence`，生产包作为 `TabRelay-extension`。

代码不依赖后端 SaaS，不自动上传到任何预设服务器。
