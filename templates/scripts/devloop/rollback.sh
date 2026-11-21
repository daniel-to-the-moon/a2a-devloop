#!/usr/bin/env bash
# rollback.yml：一键把正式站回滚到上一次（或指定的）正式发布。用 Cloudflare Pages 自带的回滚接口，不重新构建、不执行仓库代码。
# 由 pages.test.mjs 用假 Cloudflare API 测试。
#
# 输入（环境变量）：
#   CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、PROJECT
#   TARGET   要回滚到的发布 ID（留空 = 当前正式发布之前、最近一次成功的正式发布）
#   CF_API、SUMMARY 同 pages.sh
# 回滚只改 Cloudflare 上“当前生效的发布”，main 不变；下一次合并到 main 会照常发布新版本（修好再合）。
set -euo pipefail
: "${CF_API:=https://api.cloudflare.com/client/v4}"
: "${SUMMARY:=${GITHUB_STEP_SUMMARY:-/dev/null}}"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "::error::缺少 secret CLOUDFLARE_API_TOKEN" >&2; exit 1; }
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "::error::缺少 secret CLOUDFLARE_ACCOUNT_ID" >&2; exit 1; }
case "$PROJECT" in '' | *[!a-z0-9-]*) echo "::error::项目名只能是小写字母、数字、连字符：$PROJECT" >&2; exit 1 ;; esac
case "${TARGET:-}" in '' ) ;; *[!0-9a-f-]*) echo "::error::发布 ID 格式不对：$TARGET" >&2; exit 1 ;; esac

cf() {
  curl -sS -X "$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
    "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PROJECT$2"
}

list=$(cf GET "/deployments?env=production&per_page=25")
[ "$(jq -r '.success' <<< "$list" 2>/dev/null)" = "true" ] || { echo "::error::读取正式发布列表失败：$(jq -c '.errors // .' <<< "$list" 2>/dev/null || echo "$list")" >&2; exit 1; }
# 列表按时间倒序；只认成功完成的正式发布
ok=$(jq -c '[.result[] | select(.environment == "production" and .latest_stage.status == "success") | {id, sha: (.deployment_trigger.metadata.commit_hash // ""), at: .created_on}]' <<< "$list")
current=$(jq -r '.[0].id // empty' <<< "$ok")
[ -n "$current" ] || { echo "::error::没有成功的正式发布，无从回滚" >&2; exit 1; }
if [ -n "${TARGET:-}" ]; then
  target=$(jq -r --arg t "$TARGET" '.[] | select(.id == $t) | .id' <<< "$ok")
  [ -n "$target" ] || { echo "::error::$TARGET 不在最近 25 次成功的正式发布里" >&2; exit 1; }
else
  target=$(jq -r '.[1].id // empty' <<< "$ok")
  [ -n "$target" ] || { echo "::error::只有一次成功的正式发布，没有上一版可回滚" >&2; exit 1; }
fi
[ "$target" != "$current" ] || { echo "目标就是当前生效的发布，无需回滚" | tee -a "$SUMMARY"; exit 0; }
sha=$(jq -r --arg t "$target" '.[] | select(.id == $t) | .sha' <<< "$ok")
r=$(cf POST "/deployments/$target/rollback")
[ "$(jq -r '.success' <<< "$r" 2>/dev/null)" = "true" ] || { echo "::error::回滚失败：$(jq -c '.errors // .' <<< "$r" 2>/dev/null || echo "$r")" >&2; exit 1; }
echo "已回滚正式站：$current → $target（提交 ${sha:0:8}）。main 未改动，下一次合并会重新发布。" | tee -a "$SUMMARY"
echo "rolled_back_to=$target"
