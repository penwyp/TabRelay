# 工程设计

## 状态链路

浏览器事件 → 持久化 dirty/generation → 3 秒防抖 → 全窗口重新采集 → 本地 pending → WebDAV 条件发布 → 成功确认。

30 秒 Chrome Alarm 兜底；启动先等待 3 秒，完整浏览器启动等待 10 秒会话恢复。处理 dirty 的 generation 在采集前固定，只有未发生更新时才清除脏状态。已持久化 pending 必须先确认发布结果，再处理更新后的本机内容，避免“服务器已成功、本机还未收到响应”时丢失版本连续性。

## 模块

| 文件 | 职责 |
| --- | --- |
| model.ts / types.ts | 数据模型、边界校验、URL/隐私策略、来源去重、恢复计划 |
| state.ts | 本地状态串行读改写，避免并发 storage 丢更新 |
| collector.ts | 普通非无痕窗口采集、Chrome ID → 逻辑 ID、来源映射 |
| webdav.ts | 有界 HTTP、目录枚举、加密、强 ETag 条件写、恢复点与历史 |
| background.ts | MV3 事件、报警兜底、同步状态、可信消息与命令协调 |
| restore.ts | 创建意图日志、串行恢复、组重建、取消、最终核验、安全撤销 |
| sidepanel.ts / popup.ts | 实际设备浏览、细粒度选择、预检确认、状态与设置 |

## 发布协议

每个设备目录包含 device.json、current.json、recovery.json、history/。不维护全局可写索引；通过 PROPFIND 枚举。

选用“不可变历史文件上传/读取校验 → current.json 强 ETag 条件 PUT → 读取校验”的流程，而不是把临时文件 MOVE 到 current。原因：通用 If-Match 可能只保护 MOVE 源文件，不能可靠保护目标 current 的竞争写；强条件 PUT 的语义明确，服务不支持就失败。历史文件同时作为暂存与恢复点。辅助元数据单独条件写；多文件不是原子事务，失败后用同一 pending 快照幂等重试。

## 恢复协议

远端有界读取与协议校验 → 固定快照与选择 → 本机隐私规则和来源去重 → 预检确认 → 持久任务 → 新窗口/标签 → 标签组/置顶/活动恢复 → 查询实际对象核验 → 本机全量重采集并回传。

运行时创建与日志不能原子提交。创建前记录 uncertain 意图；成功得到 ID 后再落记录并清除。若 Service Worker 此间终止，任务会停在不确定状态，不自动制造副本。用户取消保留已有结果。Chrome 完整重启后 browserSession 改变，拒绝依赖旧 ID 的自动撤销/续做。

## 权限

仅 tabs、tabGroups、storage、alarms、sidePanel。生产 host 为 optional HTTPS，请用户明确选择后按 origin 授权。不声明 content scripts、cookies、history、scripting、activeTab、file 或所有站点常驻权限。消息仅接受扩展自身 ID 和扩展页面 URL，内容脚本/网页不能调用凭据或恢复操作。

## 当前工程边界

- 测试传输限定本机 HTTP；线上 HTTPS、真实 WebDAV 厂商兼容性应单独实测，不能由模拟测试推定。
- 历史恢复和加密口令变更不是迁移工具，口令轮换须新目录。
- 大型页面加载、登录、实际网站可达性不等于标签对象创建成功；最终核验会报告可观察差异。
- WebDAV 状态是每设备独立发布，不是自动全局合并；远端快照仅在用户主动选择后打开。
