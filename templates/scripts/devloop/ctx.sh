#!/usr/bin/env bash
# claude.yml work 任务第一步：确定模式（implement / fix）、目标分支与编号。由 claude.test.mjs 用假 gh 测试。
# 输入（环境变量）：EVENT（issues / issue_comment / workflow_dispatch）、N（issue 或 PR 编号）、REPO
# 输出：向 $GITHUB_OUTPUT 写 mode=、branch=、number=；不合规时以非零退出
set -euo pipefail
case "${N:-}" in '' | *[!0-9]*) echo "::error::编号必须是数字：${N:-}" >&2; exit 1 ;; esac
if [ "$EVENT" = "issues" ]; then
  mode=implement
  branch="claude/issue-$N"
else
  # issue_comment 与 workflow_dispatch 都是修复已有 PR：只接受本仓库、claude/* 分支上的 PR
  b=$(gh pr view "$N" -R "$REPO" --json headRefName,isCrossRepository -q 'select(.isCrossRepository|not) | .headRefName')
  case "$b" in claude/*) ;; *) echo "::error::只修复本仓库 claude/* 分支上的 PR（实际：${b:-跨仓库或不存在}）" >&2; exit 1 ;; esac
  mode=fix
  branch="$b"
fi
{
  echo "mode=$mode"
  echo "branch=$branch"
  echo "number=$N"
} >> "$GITHUB_OUTPUT"
