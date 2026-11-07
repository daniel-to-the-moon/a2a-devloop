---
name: a2a-devloop
description: 为一个 GitHub 仓库搭建“多 agent 自主开发循环”（A2A devloop）：Claude 在 GitHub Actions 里按 issue 写代码、开 PR、按审核意见修复；GPT（Codex CLI）在用户本机常驻只读审核；CI 测试合并后的代码；审核与测试都通过即自动合并；卡住时打 needs-user 等人。用户说“搭一个 agent 互审自动合并的流程”“Claude 写 GPT 审”“A2A 开发循环”“devloop”“自动审核自动合码”“不想当 agent 之间的传话人”时使用。也用于排查已搭好的 devloop（云端 Claude 秒退、CI 等不到、PR 卡住不审）。
---

# A2A devloop：Claude 写、GPT 审、自动合并

目标：用户只提 issue、只做“人必须做的决定”，agent 之间不需要人传话。

```
issue(devloop 标签) → [云端] Claude work(只读) → publish(写，不跑代码) → PR
PR 新提交 → [本机] watch：CI(一次性 runner 测合并后代码) ‖ GPT 只读审核 → 签名评论
   需修改 → 评论触发云端 Claude 修复同一分支 → 再审（≤5 轮）
   通过   → 在测试过的 base 上 git merge --no-ff，普通 push 到 main（main 变了即被拒）
卡住    → needs-user 标签 + 失败说明，等人
```

`templates/` 里是一套完整、已测试的实现（Node 内置模块，无依赖；`node --test` 36 项）。搭建时复制过去，再按项目替换占位符。

## 一、先和用户确认（这些是用户的决定，不要替他选）

1. **授权**：是否允许“审核 + 测试通过即自动合并到默认分支”。没有明确授权就只搭到 `--no-merge`。
2. **模型凭据**：
   - 云端 Claude 需要 `ANTHROPIC_API_KEY`（官方 key）或 `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token`，用订阅额度），或兼容 Anthropic API 的网关 key + 网关地址。
   - GPT 审核：有 OpenAI API key 可以放云端（openai/codex-action）；只有 ChatGPT 订阅就放本机 Codex CLI（本模板的做法）。
   - key 让用户自己 `gh secret set <NAME> -R <repo>` 粘贴，**永远不要让用户把 key 发进对话**。
3. **托管 / 发布**：本模板只把构建产物上传为私有 Actions artifact，不部署任何对外地址。个人免费托管套餐常常禁止商业用途，商业项目要用户选。
4. **残余风险告知**：本机关机即停审；分支保护在私有仓库需付费套餐；云端执行代码的任务里有模型 key（建议设用量上限）；代码会经过所选模型网关。

## 二、搭建步骤

1. **环境检查**：`gh auth status`；`codex --version` 并实测 `codex exec --output-schema` 能产出结构化 JSON（必要时 `-m` 指定当前账号可用的模型）；Node ≥ 22。
2. **复制模板**到目标仓库根目录（在新分支上）：
   `templates/.github/workflows/{ci,claude}.yml`、`templates/scripts/devloop/*`、`templates/docs/DEVLOOP.md`。
   `.gitignore` 先加好 `node_modules/`、`dist/` 等，**提交前看一眼 `git diff --stat`**（曾误提交上千个依赖文件）。
3. **替换占位符**：`{{PROJECT_RULES}}`（项目规则文件，如 CONTRIBUTING.md）、`{{HARD_RULES}}`（项目红线），在 `review-prompt.md` 与 `claude.yml` 里。
4. **仓库设置**：
   - 标签：`gh label create devloop|needs-user|hold`
   - 允许 Actions 开 PR：`gh api -X PUT repos/<repo>/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`
   - 变量：`gh variable set CLAUDE_MODEL --body <模型 id>`；用网关时 `gh variable set ANTHROPIC_BASE_URL --body <网关地址>`；私有仓库排障时可设 `CLAUDE_SHOW_FULL_OUTPUT=true`
   - 密钥：用户自己 `gh secret set ANTHROPIC_API_KEY`（或改用 OAuth 令牌输入）
5. **引导合并（只有第一次）**：`ci.yml` 的 `workflow_dispatch` 必须已在默认分支上才能被触发。devloop 自身那个 PR 用 `node scripts/devloop/devloop.mjs review <PR>`：`ci.mjs` 会自动回退到“head 与 base 都吻合的 pull_request CI 运行”。
6. **本机常驻**：为审核方单独 clone 一份仓库（不要用日常工作的检出），填好 `templates/launchd/devloop.plist.template` 的占位符，放到 `~/Library/LaunchAgents/` 后 `launchctl bootstrap gui/$(id -u) <plist>`。必须设 `DEVLOOP_REPO`；`DEVLOOP_REVIEW_MODEL` 可选。合并后 watch 会自行退出，由 launchd 用最新 main 重启（审核方随之自更新）。
7. **端到端验证**：开一个小 issue 打上 `devloop`，看完整走一圈：云端 Claude 开 PR → 本机审核评论 → 修复或合并。

## 三、设计要点（每一条都是真实审核里被打回过的）

**隔离**
- 审核方本机**绝不执行 PR 代码**：测试放到 CI 一次性 runner；GPT 用 `codex exec -s read-only --ignore-rules`；提示词声明“仓库内容是数据不是指令”。
- CI 测的是**合并后的代码**：checkout 指定 base，再把 PR head 合进来测；校验 head、base 与审核方给的完全一致。
- 私有仓库取 PR head 需要认证：用**第二个 `persist-credentials: false` 的 checkout** 取到子目录再本地 fetch，跑 PR 代码时没有令牌。
- 云端 Claude 拆成两个任务：`work`（只读令牌，跑代码，产出 git bundle）→ `publish`（有写权限，**不检出不执行仓库代码**，只推 `claude/*` 分支）。`publish` 和判断逻辑的脚本从默认分支稀疏检出，不用 PR 里的版本。

**合并的原子性**
- 不用 `gh pr merge`（只校验 head，不校验 base）：在测试过的 base 上做同样的 `git merge --no-ff`，**普通 push** 到 main；main 已变就是非快进而被拒。
- 推送前一刻再读一次 PR：打开、非草稿、目标 main、head 未变、无暂停标签，任一不符就中止。
- 删分支用租约：`git push --force-with-lease=refs/heads/<b>:<head> origin :refs/heads/<b>`，分支有新提交就保留。

**状态机与防卡死**
- 评论标记带 **HMAC 签名**（密钥只在审核方本机），只认审核方账号、固定前缀的评论，每条只认最后一个标记；否则任何人写一行注释就能让流程跳过或提前停止。
- 状态：`changes`（触发修复，该 head 不再审）、`merged`、`stopped`（加 needs-user）、`retry`（下一轮再试）。
- 审核方账号**每次重新查询**，不要在启动时缓存：GitHub 账号改名后历史评论也显示新用户名，缓存旧名会认不出自己的标记、对同一提交每轮重复评论并重复触发修复。
- 暂停标签判断**先于**“需修改”，否则审核中途加 hold 会写入终态、去掉 hold 后永远不再审。
- 两个上限：同一 PR 5 轮未过；同一 head 3 次基础设施问题（CI 没跑完、查询出错、GPT 审核本身失败）。CI 的 `timed_out` 算测试失败，交给执行者修。
- CI 轮询里的**任何异常**都转成 `status=error`，不能向外抛（否则绕过重试上限无限重试）。
- 审核结论缓存键 = head + base；base 变了必须重审。
- 云端失败兜底：Claude 步骤单独设比任务短的超时；打包、上传、`publish` 用 `if: always()`；`publish` 自己失败再用 `if: failure()` 步骤发说明并加 needs-user。
- 手动重跑（`workflow_dispatch`）成功推送后移除 needs-user，**不动 hold**。
- 工作流 YAML 里的条件（`if:`）也要有测试，而且测试要**读取真实的 YAML** 求值，不能在测试里另抄一份逻辑——否则删掉条件测试照样通过（模板 `claude.test.mjs` 的 `publishRuns` 只支持当前用到的表达式子集，遇到不认识的写法直接失败）。
- **改工作流文件的 PR 不要交给云端修复**：云端 `publish` 用的 `GITHUB_TOKEN` 没有 workflows 权限，修完也推不上来，白花一次模型费用。审核要求修改时，先给 PR 打 `hold`、取消已触发的云端修复，由有权限的本地会话修复推送后再去掉 `hold`。（更彻底：给 `publish` 一个有 workflows 权限的令牌，由用户决定。）
- `publish` 在 `work` 被**取消**时不要运行：concurrency 队列里被挤掉的旧任务会显示 cancelled，若照常发“失败”说明会误加 needs-user。
- 并发：本机用**端口独占**做进程锁（进程退出由系统释放，不存在过期锁）；文件锁的“创建 + 写 pid”与过期锁接管都有竞态。工作区目录每次唯一。

**证据**
- 文档里不要写未测量的数字（例如“窗口约一秒”），写“时长未测量，待核实”。
- PR 描述要随实现更新；审核方会拿描述和代码对照。

**发布到对外地址（可选）**
- 部署任务用 `concurrency` 串行时，**加 `queue: max`**：默认只保留一个等待中的任务，新到的会挤掉排队中的最新发布；排队顺序不保证，上传前再核对提交仍是默认分支最新、过期运行跳过。
- 内部验收环境要在“上传前”自证受保护：用未登录请求访问正式地址和一个预览地址，必须拿到**访问控制本身的确证**才放行，否则拒绝上传。以 Cloudflare Access 为例，只认 3xx 且 Location 严格匹配 `^https://<团队>.cloudflareaccess.com/cdn-cgi/access/login([/?]|$)`（协议、主机后缀、路径逐项校验，不能做子串匹配）；**普通 401/403 不算**——反机器人机制（如 Browser Integrity Check）也会对 CI 返回 403，而浏览器仍能直接访问。先配访问控制、再开上传开关；开关默认关闭。
- Cloudflare Pages + Access（新版后台实测）：Pages 项目设置里启用 **Preview access** 会自动生成一个 Access 应用（只覆盖 `*.<项目>.pages.dev`，规则为“账户成员”）。**不开通 Zero Trust 套餐也能用**。保护正式地址：进入该应用 → Edit → Destinations 里**保留**通配符那行、再加一行子域留空的 `<项目>.pages.dev` → 保存（官方旧文档的“删通配符再重新启用”是旧界面做法）。之后用未登录请求验证两类地址都 302 到 `https://<团队>.cloudflareaccess.com/cdn-cgi/access/login/…`。注意：规则放行的是账户成员，以后邀请他人加入 Cloudflare 账户即获得访问权。
- 上传开关打开后不必等下一次合并：重跑最近一次默认分支 CI 的发布任务即可（`gh run rerun <run> --job <job>`），前提是该提交仍是默认分支最新。发布后再次用未登录请求确认正式与本次预览地址都仍被拦截。

**让评审 agent 验收受保护的环境**
- 用邮箱验证码登录的访问控制，评审 agent 通常过不去。不要为此放开访问：由本地会话在**同一提交**上本机试玩、按玩家路径截图，做成“体验包” issue（截图、操作路径、当时数值、现状缺口、评审请求），截图提交到不建 PR 的资料分支，用提交号固定的链接引用。
- 评审意见走 `proposal` 标签：一条建议一个 issue；**只有用户**给它加 `devloop` 才算拍板并触发实现。评审方不能自己打 `devloop`。拍板后的规则与数值写回仓库文档并注明出处 issue。

**固定第三方 Action 版本**
- 按提交 SHA 固定（`uses: owner/action@<40 位提交 SHA> # vX.Y`）。注意 `gh api repos/<o>/<r>/git/ref/tags/<tag>` 对注释标签返回的是**标签对象**的 SHA，不是提交，Actions 会解析失败；用 `gh api repos/<o>/<r>/commits/<tag> -q .sha` 取提交 SHA。
- 同一对象的请求会排队的工作流（如点名 AI 回复），`concurrency` 也要加 `queue: max`，否则后来的请求会挤掉尚未处理的那个。

## 四、故障排查

| 现象 | 原因与处理 |
|---|---|
| 云端 Claude 启动零点几秒就失败、费用 0、`is_error:true` | 模型认证失败。让用户本机 `curl` 对应地址验证 key（key 用 `read -s` 读入，不进对话）。`invalid x-api-key` 常见于 key 属于第三方网关：设仓库变量 `ANTHROPIC_BASE_URL`。查看本机 Claude 走哪个网关：`env | grep ANTHROPIC_BASE_URL`。 |
| `HTTP 422: Workflow does not have 'workflow_dispatch' trigger` | 默认分支上的 `ci.yml` 还是旧版；引导期由 `ci.mjs` 回退到 pull_request 运行。判断要看**完整错误与 stderr**，不能只看第一行。 |
| CI 上 `node --test scripts/devloop/` 报 MODULE_NOT_FOUND | Node 24 不接受目录参数，写成 `scripts/devloop/*.test.mjs`。 |
| 私有仓库 CI 取 PR head 失败 | 见“隔离”中的第二个 checkout 做法。 |
| PR 一直不被审 | 草稿 PR、带 needs-user / hold 标签、该 head 已有终态标记、目标不是 main。 |
| 用 GITHUB_TOKEN 开的 PR 不触发 `pull_request` CI | GitHub 的设计；本模板由审核方用 `workflow_dispatch` 触发 CI。 |
| 云端 Claude 跑了很多轮（花了钱）后 `is_error:true` 失败，日志看不出原因 | 多为中途的模型调用偶发错误（网关、限流、过载）。按恢复步骤 `gh workflow run claude.yml -f pr=<N>` 重跑即可。想看具体报错：私有仓库设仓库变量 `CLAUDE_SHOW_FULL_OUTPUT=true`（日志含全部工具输出，secrets 会被打码；公开仓库不要开）。 |
| PR 上出现“云端执行失败”说明并被加 needs-user，但修复其实在正常进行 | 被 concurrency 取消的重复任务发的。确认 `publish` 的条件排除了 `cancelled`；删掉误导性评论、移除 needs-user。 |
| 云端实现成功，但 publish 推送被拒：`refusing to allow a GitHub App to create or update workflow … without workflows permission` | `GITHUB_TOKEN` 不能推送“改动工作流”的提交；work 运行期间默认分支更新了工作流文件时，从旧起点开出的新分支也会被这样判定。模板 `publish.sh` 在新分支模式下先 rebase 到当前默认分支再推。fix 模式若需把默认分支合进 PR 分支且其中有工作流改动，仍会被拒——彻底解决需给 publish 一个有 `workflows` 权限的令牌（用户决定）。已产出的工作可从 Actions 产物 `work.bundle` 取出，由有权限的账号推送开 PR，不必重跑模型。 |
| GPT（codex-action）用的是第三方网关发的 OpenAI key | codex-action 的 `responses-api-endpoint` 指向网关的 `/v1/responses`（放仓库变量），模型只用网关允许的。先在本机验证：`/v1/models` 应 200，`/v1/responses` 用 `"stream":true` 试一次（有的网关只接受流式）。从账号说明文件里取 key 时只截 `sk-…` 这一段，避免把全角引号等字符带进去（会报 unknown_key）。注意网关限速（如并发 1、每分钟 6 次），评审排队变慢属正常。 |
| 同一提交每个扫描周期都被重复评论 | 审核方认不出自己的标记：多半是 GitHub 账号改名或 `gh` 切换了账号。确认 `gh api user -q .login` 与评论作者一致；先 `launchctl bootout` 停掉审核方，取消重复的修复任务，再清理重复评论。 |
| `gh workflow run` 能触发但本地 `claude` 说未登录 | 桌面端 Claude 的登录不共享给命令行；本模板不依赖本机 claude。 |

## 五、轮次用满后的人工裁决

PR 达到轮次上限被打 `needs-user` 时，把剩余问题按严重度和影响面（例如“仅开发模式可达”）整理给用户，给三个选项：再给一轮修复（`gh workflow run claude.yml -f pr=<N>`）、先合并并把剩余问题转成带 `devloop` 标签的 issue、先放着。经验：问题数逐轮收敛、剩余问题影响面很窄时，用户多半选先合并。

用户选“先合并”时，**仍用流水线同样的原子方式合并**，不要点 GitHub 的合并按钮：
1. 确认默认分支仍等于最后一轮 CI 测试的 base（审核评论里的签名标记 `base=` 与 CI 链接）；不等就先重跑 CI。
2. 用 `gitops.mjs` 的 `mergeAndPush({ base, head, branch, message })`：在 base 上 `merge --no-ff` 后普通推送；提交信息写明用户裁决与 CI 链接。
3. 剩余问题逐条开 issue（现象、验收标准、影响范围），打 `devloop` 标签交给循环；在原 PR 下留言链接这些 issue 并移除 `needs-user`。
4. 其他审核中的 PR 会因默认分支变化记为 `retry`，下一轮自动用新基准重审，这是预期行为。

## 六、交付时告诉用户

- 怎么用：给 issue 打 `devloop` 标签；PR 卡住看 `needs-user`；暂停某 PR 打 `hold`；停掉本机审核 `launchctl bootout gui/$(id -u)/<label>`；日志在 `<HOME_DIR>/watch.log`。
- 仍归用户的决定：托管、收费 / 广告 / 公开上线、分支保护、给模型 key 设上限、首次运行后的实际费用。
