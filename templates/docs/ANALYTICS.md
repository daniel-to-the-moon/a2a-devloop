# 匿名统计（可选模块）

自建、最小化的匿名事件统计：浏览器上报事件名 → Cloudflare Pages Function（`functions/api/ev.js`）→ Cloudflare D1。
**是否开启是用户的决定**（仓库变量 `ANALYTICS`），流水线只负责照开关执行。

## 记什么、不记什么

| 列 | 说明 |
|---|---|
| `aid` | 浏览器本地随机生成的 UUID v4（存 `localStorage`），与账号、设备无关；清掉网站数据或关闭统计即删除 |
| `ev` | 事件名，只收 `functions/api/ev.js` 里 `EVENTS` 白名单中的名字 |
| `day` | 服务器收到时的日序号（时区在 `ev.js` 的 `DAY_OFFSET_MS` 设定，和产品的日界一致） |
| `ts` | 服务器收到的时间（UTC 毫秒） |
| `v` | 前端版本（如构建时的提交号前 12 位） |

**不记**：IP、User-Agent、Referer、屏幕、语言、任何用户输入。接收端除了用 `Origin` 拒绝跨站请求外不读任何请求头。Cloudflare 平台自身的访问日志不在仓库控制范围内，以 Cloudflare 隐私政策为准（待核实）。

## 隐私说明（项目要把它展示给用户）

> 本站只记录匿名事件：随机匿名 ID、事件名、日期和版本号，不记录 IP 和设备信息；记录满 180 天自动删除；可随时在设置里关闭。

`scripts/devloop/pages.test.mjs` 会读取本文件里“满 N 天自动删除”的 N，并校验 `pages.sh`、`d1-retention.sh` 的保留期上限是同一个数。
项目把隐私文案放到界面代码里时，把那条测试的路径改过去，保证承诺和实现不会分叉。

## 客户端要做到的（模板不含客户端代码，按项目实现并写测试）

- 只在操作**确认成功之后**上报（例如保存成功、按钮真正生效），只读页面、失败、重复点击都不计数。
- 用户可在设置里关闭；关闭时删除本地匿名 ID，重新开启生成新的、不与旧记录关联。存储写不进去时本次会话也按关闭处理。
- 本机地址（`localhost`、`127.0.0.1`，含开发服务器和 CI 冒烟测试）和调试入口不上报。
- 用 `navigator.sendBeacon` 发送，失败静默，不影响产品本身。
- 请求体只有 `{aid, ev, v}` 三项，与 `ev.js` 的 `parseEvent` 一致。

## 保存与删除

- 数据库：Cloudflare D1 `<PAGES_PROJECT>-analytics`，表结构 `functions/schema.sql`。**发布时自动按名字精确查找，没有就创建**，不需要在后台手动建。
- 保留期：默认 180 天（提案值）。仓库变量 `RETENTION_DAYS` 只能改短（1–180），超过隐私说明承诺的天数时清理与发布都会直接失败。
- `.github/workflows/analytics-retention.yml` 每天删除过期记录（`scripts/devloop/d1-retention.sh`），与发布解耦：站点停发或统计关闭后照样删除；查不了 D1（例如令牌丢了权限）就让定时任务失败，而不是假装成功。每次发布时 `pages.sh` 也会顺带清理一次。

## 开启与关闭

1. Cloudflare 令牌（secret `CLOUDFLARE_API_TOKEN`）在 Pages Edit 之外还要有 **Account → D1 → Edit**（见 `docs/LAUNCH.md` 配置清单）。
2. 仓库变量 `ANALYTICS=on`。下一次 main 发布时 `pages.sh` 查找或创建数据库、建表、清理过期记录，并把 `functions/` 与 D1 绑定一起发布；任何一步失败都整体失败、不上传。
3. 关闭：把变量改成 `off`。**不要删除变量**：每日清理靠“变量设置过”判断统计曾经开启，查不了 D1 时要报错而不是跳过。关闭后的发布不再带统计端点（客户端请求得到 404，静默失败），已存记录照样按期删除。

## 验证上线后真的在写

```sql
-- D1 控制台或 wrangler d1 execute <库名> --remote --command "…"
SELECT ev, day, COUNT(*) FROM events GROUP BY ev, day ORDER BY day DESC LIMIT 20;
```

打开一次正式地址（非本机、非调试入口）后应能看到 `session_start` 之类的记录。

## 口径示例

- 首访日：某 `aid` 最早一条记录的 `day`。
- D_n 留存：首访日为 d 的 `aid` 中，在 d + n 日有任意记录的比例；D1、D7、D30 各自独立计算，**不能相乘**。
- 匿名 ID 数 ≠ 真人数（换浏览器、清数据都会变），报告里须注明。

```sql
SELECT day, COUNT(DISTINCT aid) AS dau FROM events GROUP BY day ORDER BY day;
```
