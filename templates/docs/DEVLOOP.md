# devloop：自主开发循环

## 一、循环

```
用户 / 验收方 / 讨论结论 ──► issue，打 devloop 标签
                                   │
  【GitHub 云端】Claude（claude-code-action）
     work（只读令牌）：读 issue → 改代码 + 测试 → 本地提交 → git bundle
     publish（写权限，不执行仓库代码）：推到 claude/issue-N → 开 PR（Closes #N）
                                   │
  【审核方本机】devloop.mjs watch（每 5 分钟扫一次；本机不执行 PR 代码）
     ├─ 触发 GitHub Actions：把 PR 合并到当前 main 后跑 test / build（一次性 runner）
     └─ GPT（Codex CLI）只读审核代码
     → 结论评论到 PR，末尾带签名标记 <!-- devloop … sig=… -->
                                   │
         ┌── 需修改 / 测试失败 / 冲突 → 评论触发云端 Claude 在同一分支修复 → 再审（最多 5 轮）
         │
         └── 通过 → 在测试过的 main 上生成合并提交并推送（main 变了推送失败）→ CI 构建 main
```

## 二、组件

| 组件 | 位置 | 作用 |
|---|---|---|
| `.github/workflows/claude.yml` | GitHub Actions | `work` + `publish`：实现 issue、修复 PR；也可 `workflow_dispatch` 手动重跑某 PR 的修复 |
| `.github/workflows/ci.yml` | GitHub Actions | devloop 触发：PR 合并到指定 main 后测试；人工 PR；main 构建并上传产物 |
| `scripts/devloop/devloop.mjs` | 审核方本机 | `watch` 常驻审核；`review <PR> [--no-merge]` 手动审核一次 |
| `scripts/devloop/policy.mjs` | — | 合并决策、签名标记、轮次与重试上限 |
| `scripts/devloop/gitops.mjs` | — | 合并推送、租约删分支、CI 运行匹配、端口进程锁 |
| `scripts/devloop/ci.mjs` | — | 触发与等待 CI；任何查询异常都转为“基础设施问题” |
| `scripts/devloop/ctx.sh`、`publish.sh` | GitHub Actions（取 main 版本） | claude.yml 的判断与发布逻辑 |
| `.github/workflows/gpt-review.yml` + `cloud.mjs` | GitHub Actions（可选） | 云端审核：取代本机常驻；GPT + Claude 双评审，`decide` 触发 CI、合并或退回 |
| `scripts/devloop/combine-review.mjs` | GitHub Actions（可选） | 合并两方结论：任一方需修改即需修改 |
| `scripts/e2e/smoke.mjs`（由 `smoke.example.mjs` 改写） | CI（可选） | 浏览器冒烟验收：失败即不合并、不发布 |
| `scripts/devloop/pages.sh`、`d1-retention.sh` + `analytics-retention.yml`、`functions/` | GitHub Actions（可选） | 发布到 Cloudflare Pages、预览 / 正式分离、匿名统计（`docs/LAUNCH.md`、`docs/ANALYTICS.md`） |
| `*.test.mjs` | CI | `node --test scripts/devloop/*.test.mjs` |

## 三、角色

| 角色 | 做什么 | 不做什么 |
|---|---|---|
| Claude（云端） | 认领 `devloop` issue、写代码与测试、开 PR、按审核意见修复 | 不审核、不合并自己的 PR |
| GPT（Codex CLI） | 每个新提交独立只读审核 | 不改代码 |
| 流水线 | CI 测合并后的代码；GPT 通过 + 测试通过 + main 未变 + 无暂停标签才合并 | 不在本机执行 PR 代码 |
| 用户 | 收费 / 广告 / 对公众上线、托管、分支保护、裁决 `needs-user` | — |

## 四、issue 格式

- 标签 `devloop`（打上即触发）；一个 issue 一件事
- 正文：现象 / 需求、可勾选的验收标准、数值或事实主张的依据（缺的标“待核实”）

## 五、停止条件、标签与评论标记

| 标签 | 含义 |
|---|---|
| `needs-user` | 循环停下等用户：同一 PR 5 轮未通过（`ROUND_LIMIT_MODE=needs-user`，默认）；auto 模式下出现 blocker 或意见数回升；同一提交 3 次基础设施问题；Claude 判断命中停止条件；云端执行失败。这些评论会 @ 仓库所有者（GitHub 才会通知；环境变量 `DEVLOOP_NOTIFY` 可改成别人，设为空则不 @），等视觉验收的结果评论同样会 @ |
| `hold` | 用户手动暂停某 PR |

Claude 遇到以下情况不写代码，说明原因并加 `needs-user`：收费 / 广告 / 对公众上线；需要新的付费服务或账号；需求互相矛盾或违反项目硬边界；信息不足。

标记 `state:reason`：`changes`（触发修复，该提交不再审）、`merged`、`stopped`、`retry`（下一轮重试）。HMAC 签名，密钥只在审核方本机；只认审核方账号、以“执行者：GPT”开头的评论，每条只认最后一个标记。只处理“打开、非草稿、目标 main”的 PR。

### 轮次用满后的处理（仓库变量 `ROUND_LIMIT_MODE`，用户自选）

| 值 | 第 5 轮仍未通过时 |
|---|---|
| `needs-user`（默认，未设置也是它） | 停下、加 `needs-user`，等用户裁决。 |
| `auto`（免人工合码） | 有 blocker 或意见数比上一轮多 → 仍停下加 `needs-user`；意见数减少 → 自动追加一轮（最多追加 3 轮）；持平或追加用完，且剩余只有 major / minor、CI 通过、无冲突 → 合并，剩余意见逐条开 `devloop` issue。 |

切换：`gh variable set ROUND_LIMIT_MODE --body auto`（改回 `--body needs-user`）。风险：auto 会合并 GPT 仍认为有 major 问题的代码，靠后续 issue 修。

## 讨论与 GPT 云端评审（可选）

- 讨论 issue 打上 `discussion` / `proposal` 标签时，`gpt-discuss.yml` 让 GPT 按证据规则评审一次；之后评论里写 `@gpt` 再回答那条评论。
- 需要 secret `OPENAI_API_KEY`；用网关时设变量 `GPT_RESPONSES_ENDPOINT`、`GPT_MODEL`。
- GPT 只评审与提问，不拍板；用户给 `proposal` 加 `devloop` 即同意实现。

## 云端审核与双评审（可选，仓库变量 `CLOUD_REVIEW=on`）

- `gpt-review.yml` 每 10 分钟扫描（GitHub 定时可能延后），手动：`gh workflow run gpt-review.yml -f pr=<编号>`（不受开关限制）。
- 结构：`select`（只读，选一个 PR）→ `review`（只读：GPT 用 codex-action `:read-only` 审；Claude 只给 Read / Glob / Grep 再独立审一遍）→ `decide`（有写权限、不运行模型：触发 CI、判定、合并或退回、评论）。整个工作流全局串行。
- **合并规则**：GPT 与 Claude **都通过**、CI（合并后的代码 + 浏览器冒烟）通过、main 未变、无暂停标签才合并；任一方需修改即退回，意见标 `[GPT]` / `[Claude]`。Claude 结论缺失或不合法按“审核未完成”处理（计入同一提交 3 次上限），不会只凭一方放行。`SECOND_REVIEW=off` 关闭第二审核方。
- **后续动作**：`GITHUB_TOKEN` 发的评论不会触发 `claude.yml`，所以需修改时 `decide` 直接 `workflow_dispatch` 修复；`GITHUB_TOKEN` 推 main 不触发 push 工作流，所以合并后 `decide` 触发 `ci.yml -f deploy_main=true` 完成发布。
- **分工**：云端只审不改 `.github/workflows/` 的 PR；改工作流的 PR 由本机审核方或有权限的本地会话处理。
- **信任边界**：不设 `pull_request` 入口；定时只用 main 上的定义，手动触发时各任务校验 `github.ref == refs/heads/main`。
- **凭据**：`OPENAI_API_KEY`（+ 可选 `GPT_RESPONSES_ENDPOINT`、`GPT_MODEL`）、`CLAUDE_CODE_OAUTH_TOKEN`（推荐：用户本机 `claude setup-token` 生成、自己 `gh secret set`；设了就不走网关）或 `ANTHROPIC_API_KEY`（+ 可选 `ANTHROPIC_BASE_URL`），可选 `CLAUDE_REVIEW_MODEL`（未设沿用 `CLAUDE_MODEL`）、`DEVLOOP_MARKER_KEY`（与本机审核方同一把，两边审核记录互认）。
- **启动失败会自动重试**：审核任务本身失败（例如 runner 环境问题导致 codex-action 起不来）记为基础设施问题，下一轮扫描重试同一提交；同一提交累计 3 次才停下加 `needs-user`。

## 浏览器冒烟验收（可选）

把 `scripts/e2e/smoke.example.mjs` 按产品核心路径改好、改名为 `scripts/e2e/smoke.mjs`，`ci.yml` 就会在构建后用 Playwright 打开构建产物跑一遍；失败即 CI 失败（不合并、不发布），截图作为 Actions 产物保留 7 天。项目需把 `playwright` 加进 devDependencies；预览命令可用仓库变量 `E2E_PREVIEW_CMD` 覆盖（须监听 `127.0.0.1:4173`）。

## 验收与发布角色（可选，`scripts/devloop/gates.json`）

模型互审只审代码。改画面的 PR 另外过五道：

| 角色 | 谁来做 | 不通过时 |
|---|---|---|
| 性能验收 | `ci.yml` → `scripts/e2e/gates.mjs`：WebGL draw call / 三角形按固定场景比 `scripts/e2e/budgets.json` | CI 失败，交 Claude 修 |
| 视觉验收 | `accept.yml` judge → `visual-judge.mjs`：截图 + 上一版截图 + `docs/visual/STYLE.md`（+ 参考图）交多模态模型打分，先做多模态自检 | 未达标交 Claude 修（最多 3 轮后 `needs-user`）；评分没完成不自动通过 |
| 发布把关 | `cloud.mjs decide` + `accept.yml` preview：过审核与 CI 后发 Access 保护的预览 `pr-<编号>.<子域>`，加 `awaiting-acceptance` | 用户加 `accepted`（仓库所有者、晚于最新提交）才合并；正式站出问题：Actions → rollback |
| 合并排期 | `cloud.mjs select`：与更早、在途的 PR 改同一文件就排队 | 前面的 PR 在等人时不挡队 |
| 真机试玩 | 用户每个里程碑按 `.github/ISSUE_TEMPLATE/playtest.md` 在手机上玩一次 | 开 issue |

评分方：仓库变量 `VISUAL_PROVIDER`（`openai` 默认 / `anthropic`）+ `VISUAL_MODEL`；写代码的是 Claude，默认不让它自评。
标签：`awaiting-acceptance`（等用户看预览，云端审核不再处理）、`accepted`（用户确认，下一轮合并）。

## 发布与上线（可选）

见 `docs/LAUNCH.md`：内部预览由 Cloudflare Access 保护、正式地址由用户用 `PAGES_PUBLIC=true` 决定何时公开；匿名统计见 `docs/ANALYTICS.md`。开关都是仓库变量，**改值、不删变量**。

## 费用口径

- **AI 网关费用单独计算**：云端 Claude 开发、GPT / Claude 审核、GPT 讨论都走模型 API（或网关），按用量计费，和项目的现金预算分开记账、分开设上限（在模型控制台 / 网关给 key 设用量上限）。
- **现金预算**只算托管、域名、第三方服务等；按月还是总额、上限多少由用户定，写进项目文档。
- GitHub Actions：私有仓库有每月免费分钟数，超出另计；双评审每个提交多一次 Claude 审核用量。单次花费没有实测前写“待核实”。

## 六、恢复

1. 看 PR / issue 下的失败说明与 Actions 日志，排除原因；
2. `gh workflow run claude.yml -f pr=<PR号>` 手动重跑修复；成功推送后自动移除 `needs-user`（不动 `hold`）。

## 七、残余风险

- `work` 任务里有模型 API key 并执行仓库代码，依赖投毒可能泄露该 key（拿不到写仓库令牌）→ 给 key 设用量上限。
- 推送前最后核对与推送之间有很短的窗口；由 GitHub 强制需分支保护（私有仓库需付费套餐）。
- 审核方本机关机 / 睡眠时不审核、不合并。
- 云端审核：有仓库写权限、且能推送 `.github/workflows/` 改动的账号，可以推一个改过 YAML 的分支再对它手动触发，从而读到仓库级 secret；真正隔离需把签名密钥移进只允许 main 部署的 environment（私有仓库可能需付费套餐），由用户决定。
- 合并即发布：自动合并后会自动发布到预览（公开模式下也包括正式地址）；只适合能快速回滚的产品。
