# a2a-devloop

一个 Claude Code skill：为 GitHub 仓库搭建“多 agent 自主开发循环”。

- **Claude**（GitHub Actions 云端）按 issue 写代码、开 PR、按审核意见修复
- **GPT**（Codex CLI，审核方本机常驻）只读审核每个新提交
- **CI** 在一次性 runner 上测试“PR 合并到当前默认分支之后”的代码
- 可选：**GPT 云端参与讨论**——讨论 issue 打上 `discussion` / `proposal` 标签自动评审，评论里 `@gpt` 点名再回答
- 可选：**云端双评审**——GPT（codex-action）和 Claude 各审一次，两方都通过才合并，不需要用户电脑在线
- 可选：**浏览器冒烟验收**——CI 用真实 Chromium 跑一遍核心路径，失败不合并、不发布
- 可选：**合并即发布到 Cloudflare Pages**——预览地址受 Access 保护，正式地址由用户用仓库变量 `PAGES_PUBLIC=true` 决定何时公开；`ANALYTICS=on` 时连同自建匿名统计（D1，自动建库）一起发布
- 审核与测试都通过即自动合并；卡住时打 `needs-user` 标签等人

用户只提 issue、只做必须由人做的决定，agent 之间不需要人传话。

## 适合什么项目

适合“错了也便宜、能快速回滚”的项目：个人或小团队、早期产品 / 原型 / 小游戏 / 工具站，需求能拆成带验收标准的小 issue，测试和构建能在 CI 里几分钟跑完，发布物是静态前端。

不适合直接全套照搬：有状态的生产后端、数据库迁移、支付与真钱、受监管行业、要求多人审批与分支保护的团队、核心验收离不开人的项目（真机、硬件、上架审核）、代码不能经过第三方模型网关的项目、面向中国大陆公众的正式上线（发布模块需换平台）。这些情况可以只用循环和审核、把合并或发布留给人。详见 [SKILL.md 第零节](SKILL.md)。

## 安装

```bash
git clone <本仓库地址> ~/.claude/skills/a2a-devloop
```

## 使用

在 Claude Code 里：

```
/a2a-devloop 给 owner/repo 搭一个 Claude 写、GPT 审、自动合并的开发流程
```

或直接说“帮我搭 devloop”“Claude 写 GPT 审、自动合并”“我不想当 agent 之间的传话人”，skill 会被自动调用。

详见 [SKILL.md](SKILL.md)：搭建前要确认的决定、搭建步骤、设计要点、故障排查。

## 内容

- `SKILL.md`：skill 本体
- `templates/`：完整实现（GitHub Actions 工作流：执行者、CI + 发布、讨论评审、云端审核、统计清理；审核方脚本、Pages 发布脚本、统计接收端、冒烟测试骨架、launchd 模板、流程文档 DEVLOOP / LAUNCH / ANALYTICS），Node 内置模块、无依赖；`cd templates && node --test scripts/devloop/*.test.mjs` 共 141 项测试
- `templates/docs/LAUNCH.md`：上线配置清单（Cloudflare 令牌权限、Access 预览 / 正式分离、公开开关、踩过的坑）

## 前置条件

- GitHub 仓库与已登录的 `gh` CLI
- 云端 Claude 的凭据：Anthropic API key、`claude setup-token` 的 OAuth 令牌，或兼容 Anthropic API 的网关 key + 网关地址
- 审核方：本机 Codex CLI（ChatGPT 订阅即可）+ Node ≥ 22，本机常驻示例为 macOS launchd；或云端模式（OpenAI API key，第二审核方用 Anthropic key）
- 发布（可选）：Cloudflare 账户，个人资料页创建的 API 令牌（Pages Edit + D1 Edit）

## 许可证

[MIT](LICENSE)
