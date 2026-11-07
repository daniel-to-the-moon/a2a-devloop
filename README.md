# a2a-devloop

一个 Claude Code skill：为 GitHub 仓库搭建“多 agent 自主开发循环”。

- **Claude**（GitHub Actions 云端）按 issue 写代码、开 PR、按审核意见修复
- **GPT**（Codex CLI，审核方本机常驻）只读审核每个新提交
- **CI** 在一次性 runner 上测试“PR 合并到当前默认分支之后”的代码
- 审核与测试都通过即自动合并；卡住时打 `needs-user` 标签等人

用户只提 issue、只做必须由人做的决定，agent 之间不需要人传话。

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
- `templates/`：完整实现（两个 GitHub Actions 工作流、审核方脚本、launchd 模板、流程文档），Node 内置模块、无依赖；`node --test templates/scripts/devloop/*.test.mjs` 共 35 项测试

## 前置条件

- GitHub 仓库与已登录的 `gh` CLI
- 云端 Claude 的凭据：Anthropic API key、`claude setup-token` 的 OAuth 令牌，或兼容 Anthropic API 的网关 key + 网关地址
- 审核方：Codex CLI（ChatGPT 订阅即可）+ Node ≥ 22；本机常驻示例为 macOS launchd

## 许可证

[MIT](LICENSE)
