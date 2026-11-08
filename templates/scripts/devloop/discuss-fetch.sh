#!/usr/bin/env bash
# 取讨论 issue 的正文与全部评论（分页），供 discuss-build.mjs 使用。由 discuss-build.test.mjs 用严格的假 gh 测试。
# 用法：discuss-fetch.sh <owner/repo> <issue 编号> <输出目录>  → <目录>/issue.json、<目录>/comments.jsonl（每行一条评论）
# 已用真实 gh 核对：--paginate 配 --jq '.[] | {…}' 每条评论输出一行紧凑 JSON，跨页连续，正文换行已转义。
set -euo pipefail
repo=$1 n=$2 out=$3
case "$n" in '' | *[!0-9]*) echo "::error::编号必须是数字：$n" >&2; exit 1 ;; esac
mkdir -p "$out"
gh api "repos/$repo/issues/$n" > "$out/issue.json"
gh api --paginate "repos/$repo/issues/$n/comments?per_page=100" \
  --jq '.[] | {id, body, created_at, html_url, user: {login: .user.login, type: .user.type}}' > "$out/comments.jsonl"
