#!/usr/bin/env bash
# claude.yml publish 任务：推送成功后，主动触发云端审核（gpt-review.yml，只审这个 PR），不等定时兜底扫描。
# GITHUB_TOKEN 推送不会触发其他工作流，所以要显式 dispatch。只传 PR 编号：head/base 由审核端重新读取，旧事件不会审旧代码。
# 尽力而为：任何失败都只打印警告、退出 0（兜底扫描仍会发现这个 PR），不能让发布步骤变红而加 needs-user。
# 输入（环境变量）：OUT（work 产物目录）、REPO、N、MODE、BRANCH。本脚本来自 main（可信），不执行 PR 里的任何代码。
set -uo pipefail
if [ "$(tr -d '[:space:]' < "$OUT/outcome" 2>/dev/null || true)" != "pr" ]; then echo "无推送，不触发审核"; exit 0; fi
if [ "$MODE" = "fix" ]; then
  pr="$N"
else
  pr=$(gh pr list -R "$REPO" --head "$BRANCH" --state open --json number -q '.[0].number' 2>/dev/null || true)
fi
case "$pr" in '' | 0* | *[!0-9]*) echo "::warning::未找到 PR 编号，跳过审核触发（由兜底扫描处理）"; exit 0 ;; esac
if gh workflow run gpt-review.yml -R "$REPO" --ref main -f "pr=$pr"; then
  echo "已触发云端审核 PR #$pr"
else
  echo "::warning::触发云端审核失败（由兜底扫描处理）"
fi
exit 0
