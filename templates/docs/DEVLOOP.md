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
| `needs-user` | 循环停下等用户：同一 PR 5 轮未通过（`ROUND_LIMIT_MODE=needs-user`，默认）；auto 模式下出现 blocker 或意见数回升；同一提交 3 次基础设施问题；Claude 判断命中停止条件；云端执行失败 |
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

## 六、恢复

1. 看 PR / issue 下的失败说明与 Actions 日志，排除原因；
2. `gh workflow run claude.yml -f pr=<PR号>` 手动重跑修复；成功推送后自动移除 `needs-user`（不动 `hold`）。

## 七、残余风险

- `work` 任务里有模型 API key 并执行仓库代码，依赖投毒可能泄露该 key（拿不到写仓库令牌）→ 给 key 设用量上限。
- 推送前最后核对与推送之间有很短的窗口；由 GitHub 强制需分支保护（私有仓库需付费套餐）。
- 审核方本机关机 / 睡眠时不审核、不合并。
