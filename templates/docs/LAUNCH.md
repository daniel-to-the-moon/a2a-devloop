# 发布与上线：内部预览 / 公开正式分离（可选模块）

适用：静态前端（可带少量 Pages Functions）发布到 Cloudflare Pages。main 每次更新自动发布；**预览地址始终只给自己看，正式地址由用户决定何时公开**。

```
main 更新 ─► ci.yml test（测试 + 构建 + 浏览器冒烟）─► pages 任务（pages.sh）
                                                  ├─ PAGES_DEPLOY != true：只确保项目存在、打印地址，不上传
                                                  ├─ PAGES_PUBLIC != true：上传前确认正式 + 预览地址都被 Access 拦截，否则拒绝
                                                  ├─ PAGES_PUBLIC == true：正式地址公开，预览地址仍必须被 Access 拦截，否则拒绝
                                                  └─ ANALYTICS == on：查找/创建 D1、建表、清理过期记录，连同 functions/ 一起发布
云端审核合并后（GITHUB_TOKEN 推 main 不触发 push）：decide 主动触发 ci.yml -f deploy_main=true 走同一条发布路径
```

## 一、开关（全部是 GitHub 仓库变量，只由用户拨）

| 变量 | 取值 | 作用 |
|---|---|---|
| `PAGES_PROJECT` | Pages 项目名（小写字母、数字、连字符） | 设了才运行 pages 任务与每日清理；D1 库名是 `<项目名>-analytics` |
| `PAGES_DEPLOY` | `true` / 其他 | `true` 才上传；否则只确保项目存在并在运行摘要里打印地址 |
| `PAGES_PUBLIC` | `true` / 其他 | `true` 才允许正式地址不受 Access 保护；未设时只要 Access 撤掉，发布就会被拒（防误公开）。预览地址在任何模式下都必须受保护 |
| `ANALYTICS` | `on` / `off` | 匿名统计（`docs/ANALYTICS.md`）。关闭用 `off`，**不要删除变量** |
| `RETENTION_DAYS` | 1–180 | 统计保留天数，只能改短 |

原则：**改开关，不删变量**。删变量会让流水线把“从没开过”和“开过又关了”混为一谈。

## 二、配置清单（按顺序，每步都有验证）

凭据由用户自己 `gh secret set <名字> -R <仓库>` 粘贴，不进对话、不写进仓库。账户 ID、令牌值、数据库 ID 都不要写进文档或代码。

1. **建令牌**：Cloudflare 后台右上角头像 → **My Profile → API Tokens** → Create Token（自定义）。
   - 权限两条：**Account → Cloudflare Pages → Edit**、**Account → D1 → Edit**（不开统计可以只要第一条，但以后开统计时最容易忘）。
   - 新版后台是“勾选列表”式加权限：勾完要往下滚到底点保存 / Continue to summary，**回到令牌列表再打开一次确认两条权限都在**。曾经以为加上了 D1 Edit、实际只保存了 Pages，发布在 D1 查询处失败。
   - 这是个人资料页下的用户令牌，以后改权限也要回到 **My Profile → API Tokens** 找它；账户级的 Account API Tokens 页面里看不到它。
2. **存凭据**：`gh secret set CLOUDFLARE_API_TOKEN`、`gh secret set CLOUDFLARE_ACCOUNT_ID`（账户 ID 在 Workers & Pages 概览页右侧）。
   - 如果令牌被 **Roll**（重新生成）过，旧值立即失效：马上把新值更新到 `CLOUDFLARE_API_TOKEN`，之后**不要再 Roll**——每 Roll 一次都要同步一次 secret，中间的发布全部失败。改权限不需要 Roll，直接编辑保存即可。
3. **建项目**：设 `PAGES_PROJECT=<项目名>`，等 main 的 CI 跑一次（或重跑最近一次 main 的 CI），运行摘要里会打印 `https://<项目名>.pages.dev`。
4. **先上锁（Access）**：Pages 项目 → Settings → **Preview access** 启用，Cloudflare 自动生成一个 Access 应用（只覆盖预览 `*.<项目名>.pages.dev`，规则为“账户成员”）。不开通 Zero Trust 付费套餐也能用。
   - 要连正式地址一起保护：Preview access 旁的 **Manage** → 进入该应用 → Edit → Destinations 里**保留**通配符那行，再加一行子域留空的 `<项目名>.pages.dev` → 保存。
   - 验证：未登录请求访问 `https://<项目名>.pages.dev/` 与 `https://x.<项目名>.pages.dev/`，都应 302 到 `https://<团队>.cloudflareaccess.com/cdn-cgi/access/login/…`。
   - 规则放行的是 Cloudflare 账户成员，以后邀请别人进账户即获得访问权。
5. **开上传**：`PAGES_DEPLOY=true`，重跑最近一次 main CI 的 pages 任务（`gh run rerun <run> --job <job>`，前提是该提交仍是 main 最新）。`pages.sh` 会再自证一次两类地址都被 Access 拦截才上传。
6. **（可选）开统计**：确认令牌有 D1 Edit → `ANALYTICS=on` → 下一次发布时自动创建 `<项目名>-analytics` 库与表。不用在 D1 后台手动建库（免费套餐可用，后台不会出现开通或条款提示）。
7. **公开上线（用户决定）**：
   1. `PAGES_PUBLIC=true`。
   2. 撤掉正式地址的 Access：Pages 项目 → Settings → **Preview access → Manage** → 进入那个 Access 应用 → Edit → Destinations，**只删掉 `<项目名>.pages.dev` 那一行**，保留 `*.<项目名>.pages.dev` → 保存。预览版本仍只给自己看。
   3. **不要走 Zero Trust → Access → Applications 列表页**：没开通 Zero Trust 套餐时那里会被 “Choose a plan” 挡住，**不要点它**；从 Pages 的 Manage 入口进去就能编辑同一个应用。
   4. 验证：无痕窗口打开正式地址直接进入产品；`x.<项目名>.pages.dev` 仍跳 Access 登录页；开了统计的话按 `docs/ANALYTICS.md` 的 SQL 确认有新记录。
   - 回退：`PAGES_PUBLIC` 改回非 `true`，并在 Destinations 里把正式地址那一行加回来。

## 三、为什么这样设计

- **pages 任务不执行应用代码**：只稀疏检出 main 的 `scripts/devloop` 与 `functions/`，下载 test 任务的构建产物，用固定版本的 wrangler 上传；Cloudflare 凭据只在这一个任务里。
- **串行且不丢排队**：`concurrency` 加 `queue: max`；上传前核对本次提交仍是 main 最新，慢的旧运行或历史重跑跳过，不会把环境回退。
- **Access 自证只认确证**：3xx 且 Location 严格匹配 `^https://<团队>.cloudflareaccess.com/cdn-cgi/access/login([/?]|$)`；普通 401/403 不算（Browser Integrity Check 等反机器人机制也会对 CI 返回 403，浏览器却能直接访问）。
- **D1 失败就整体不上传**：不会发布一个统计端点指向不存在数据库的版本。

## 四、不适用 / 需要另外设计

- **中国大陆公众访问**：`*.pages.dev` 在大陆常不可达或很慢；需要国内平台 + ICP 备案域名，游戏类还涉及版号、实名、防沉迷。构建产物是纯静态文件，换平台只需替换 pages 任务。
- **自定义域名**：要在 Access 里另建 Self-hosted 应用覆盖它；已有 Access 策略的域名不能再添加为 Pages 自定义域名（官方已知问题）。
- **有状态后端、数据库迁移、支付**：这套“合并即发布”只适合可秒级回滚的静态站点，见 SKILL.md“适用场景”。
- 免费托管套餐条款常有商用限制（例如 Vercel Hobby），商业项目由用户选托管。
