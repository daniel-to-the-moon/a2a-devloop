#!/usr/bin/env bash
# ci.yml pages 任务：发布到 Cloudflare Pages。由 pages.test.mjs 用假 curl / gh / wrangler 测试。
# 本脚本取自 main（可信），只上传 test 任务构建好的 dist，不执行仓库里的其他代码。
#
# 输入（环境变量）：
#   CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID  凭据
#   PROJECT    Pages 项目名
#   SHA        本次运行对应的 main 提交
#   DEPLOY     为 "true" 时才上传
#   DIST       构建产物目录
#   REPO、GH_TOKEN  用于核对 SHA 是否仍是 main 最新提交
#   WRANGLER   wrangler 调用前缀（默认 "npx -y wrangler@<固定版本>"）
#   CF_API     Cloudflare API 基地址（默认官方；测试时指向假服务）
#   SUMMARY    摘要输出文件（默认 $GITHUB_STEP_SUMMARY）
#   PUBLIC     为 "true" 时公开发布：正式地址不再要求 Access 保护（预览地址仍要求）（对公众上线是用户的决定，只由用户拨这个仓库变量）
#   ANALYTICS  为 "on" 时启用匿名统计：确保 D1 数据库与表存在、清理超过保留期的记录，连同 functions/ 一起发布
#   FUNCTIONS_DIR  Pages Functions 目录（取自 main 的 functions/，内含 api/ev.js；schema.sql 在其中）
#   RETENTION_DAYS 统计记录保留天数（默认 180，提案值；不得超过隐私说明承诺的 180）
set -euo pipefail
: "${CF_API:=https://api.cloudflare.com/client/v4}"
: "${WRANGLER:=npx -y wrangler@4.158.0}"
: "${SUMMARY:=${GITHUB_STEP_SUMMARY:-/dev/null}}"
: "${RETENTION_DAYS:=180}"

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "::error::缺少 secret CLOUDFLARE_API_TOKEN" >&2; exit 1; }
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "::error::缺少 secret CLOUDFLARE_ACCOUNT_ID" >&2; exit 1; }
case "$PROJECT" in '' | *[!a-z0-9-]*) echo "::error::项目名只能是小写字母、数字、连字符：$PROJECT" >&2; exit 1 ;; esac

cf() { # cf <METHOD> <路径> [JSON 正文] → 输出响应正文；HTTP 状态写到 $CF_STATUS_FILE
  local method=$1 path=$2 body=${3:-}
  curl -sS -o "$tmp/resp" -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
    ${body:+--data "$body"} "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID$path" > "$tmp/status"
  cat "$tmp/resp"
}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 1. 按名字精确查询项目；不存在才创建；拿不到项目就失败并保留 Cloudflare 的错误信息
info=$(cf GET "/pages/projects/$PROJECT")
if [ "$(cat "$tmp/status")" = "404" ]; then
  info=$(cf POST "/pages/projects" "{\"name\":\"$PROJECT\",\"production_branch\":\"main\"}")
fi
if [ "$(jq -r '.success' <<< "$info")" != "true" ] || [ "$(jq -r '.result.name' <<< "$info")" != "$PROJECT" ]; then
  echo "::error::无法取得 Pages 项目 $PROJECT：$(jq -c '.errors // .' <<< "$info" 2>/dev/null || echo "$info")" >&2
  exit 1
fi
subdomain=$(jq -r '.result.subdomain' <<< "$info")
{
  echo "### Cloudflare Pages 项目：$PROJECT"
  echo "- 正式地址：https://$subdomain"
  echo "- 预览地址：https://*.$subdomain（Access 应用需同时覆盖）"
} >> "$SUMMARY"
echo "project=$PROJECT subdomain=$subdomain"

# 2. 开关
if [ "${DEPLOY:-}" != "true" ]; then
  echo "PAGES_DEPLOY 未设为 true：只确保项目存在，没有上传。先在 Cloudflare Access 为上面的地址配好访问限制。" | tee -a "$SUMMARY"
  exit 0
fi

# 3. 过期检查：只发布 main 当前最新提交（防止慢的旧运行或历史重跑把环境回退到旧版本）
latest=$(gh api "repos/$REPO/commits/main" -q .sha)
if [ "$latest" != "$SHA" ]; then
  echo "跳过：本次运行的提交 ${SHA:0:8} 已不是 main 最新（${latest:0:8}），由更新的运行发布。" | tee -a "$SUMMARY"
  exit 0
fi

[ -f "$DIST/index.html" ] || { echo "::error::构建产物 $DIST 不完整（缺 index.html）" >&2; exit 1; }

# 4. Access 兜底：未登录访问正式地址与任一预览地址，都必须拿到“Cloudflare Access 登录页重定向”这一确证，否则拒绝上传。
#    只认：3xx 且 Location 为 https://<团队>.cloudflareaccess.com/cdn-cgi/access/login…（协议、主机后缀、路径逐项严格匹配）。
#    普通 401/403 一律不算：Cloudflare 的 Browser Integrity Check 等反机器人机制也会对 CI 请求返回 403，而浏览器仍能直接访问。
: "${ACCESS_CHECK_SCHEME:=https}"
ACCESS_LOGIN_RE='^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com/cdn-cgi/access/login([/?]|$)'
protected() { # protected <主机名>
  local r code loc
  # ACCESS_CHECK_CONNECT 仅供测试：把任意主机名的连接转到本地假服务
  r=$(curl -sS -o /dev/null --max-time 20 -w '%{http_code} %{redirect_url}' \
    ${ACCESS_CHECK_CONNECT:+--connect-to "::$ACCESS_CHECK_CONNECT"} "$ACCESS_CHECK_SCHEME://$1/") || return 1
  code=${r%% *}
  loc=${r#* }
  case "$code" in 301 | 302 | 303 | 307 | 308) [[ "$loc" =~ $ACCESS_LOGIN_RE ]] ;; *) return 1 ;; esac
}
# 公开模式只豁免正式地址；预览地址无论如何都必须仍受 Access 保护（公开上线时误删通配符那一行，发布会被拒）
hosts=("$subdomain" "devloop-access-check.$subdomain")
if [ "${PUBLIC:-}" = "true" ]; then
  echo "公开发布（PAGES_PUBLIC=true）：正式地址 https://$subdomain 任何人都能访问；预览地址仍要求 Access 保护" | tee -a "$SUMMARY"
  hosts=("devloop-access-check.$subdomain")
fi
for host in "${hosts[@]}"; do
  protected "$host" || {
    if [ "$host" = "$subdomain" ]; then hint="若已决定公开上线，设仓库变量 PAGES_PUBLIC=true。"; else hint="预览地址 *.$subdomain 必须始终受保护：检查 Access 应用的 Destinations 里通配符那一行是否还在。"; fi
    echo "::error::$host 未确认受 Cloudflare Access 保护（未登录请求没有被重定向到 Access 登录页），拒绝上传。按 docs/LAUNCH.md 配置后重试；$hint" >&2
    exit 1
  }
done

# 5. 匿名统计（ANALYTICS=on）：D1 数据库按名字精确查找或创建 → 建表 → 清理过期记录 → 连同 functions/ 与 D1 绑定一起发布。
#    任何一步失败都整体失败、不上传（不会发布一个统计端点指向不存在的数据库的版本）。
site="$DIST"
workdir="$PWD"
if [ "${ANALYTICS:-}" = "on" ]; then
  [ -f "${FUNCTIONS_DIR:-}/api/ev.js" ] && [ -f "$FUNCTIONS_DIR/schema.sql" ] || { echo "::error::缺少 functions 目录（api/ev.js、schema.sql）：${FUNCTIONS_DIR:-未设置}" >&2; exit 1; }
  dbname="$PROJECT-analytics"
  list=$(cf GET "/d1/database?name=$dbname&per_page=100")
  [ "$(jq -r '.success' <<< "$list" 2>/dev/null)" = "true" ] || { echo "::error::查询 D1 数据库失败（令牌需要 Account → D1 → Edit 权限）：$(jq -c '.errors // .' <<< "$list" 2>/dev/null || echo "$list")" >&2; exit 1; }
  dbid=$(jq -r --arg n "$dbname" '[.result[]? | select(.name == $n)][0].uuid // empty' <<< "$list")
  if [ -z "$dbid" ]; then
    made=$(cf POST "/d1/database" "$(jq -nc --arg n "$dbname" '{name: $n}')")
    dbid=$(jq -r --arg n "$dbname" 'select(.success == true and .result.name == $n) | .result.uuid // empty' <<< "$made" 2>/dev/null || true)
    [ -n "$dbid" ] || { echo "::error::创建 D1 数据库 $dbname 失败：$(jq -c '.errors // .' <<< "$made" 2>/dev/null || echo "$made")" >&2; exit 1; }
    echo "已创建 D1 数据库 $dbname" | tee -a "$SUMMARY"
  fi
  case "$dbid" in *[!0-9a-f-]*) echo "::error::D1 数据库 ID 格式异常：$dbid" >&2; exit 1 ;; esac
  d1() { # d1 <JSON 正文>：执行一条语句，失败即退出
    local r
    r=$(cf POST "/d1/database/$dbid/query" "$1")
    [ "$(jq -r '.success' <<< "$r" 2>/dev/null)" = "true" ] || { echo "::error::D1 执行失败：$(jq -c '.errors // .' <<< "$r" 2>/dev/null || echo "$r")" >&2; exit 1; }
  }
  # schema.sql 按分号拆成单条语句逐条执行（均为 IF NOT EXISTS，可重复执行）
  while IFS= read -r stmt; do
    d1 "$(jq -nc --argjson s "$stmt" '{sql: $s}')"
  done < <(jq -Rrs 'split(";") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) | .[] | @json' "$FUNCTIONS_DIR/schema.sql")
  # 隐私说明向用户承诺“满 180 天自动删除”（docs/ANALYTICS.md）：只能改短，不能改长
  case "$RETENTION_DAYS" in '' | *[!0-9]* | 0*) echo "::error::RETENTION_DAYS 必须是 1–180 的整数：$RETENTION_DAYS" >&2; exit 1 ;; esac
  [ "$RETENTION_DAYS" -le 180 ] || { echo "::error::RETENTION_DAYS 不能超过隐私说明承诺的 180 天：$RETENTION_DAYS" >&2; exit 1; }
  cutoff=$(( ($(date +%s) - RETENTION_DAYS * 86400) * 1000 ))
  d1 "$(jq -nc --argjson c "$cutoff" '{sql: "DELETE FROM events WHERE ts < ?1", params: [$c]}')"
  echo "匿名统计：D1 $dbname 就绪，已清理 $RETENTION_DAYS 天前的记录" | tee -a "$SUMMARY"
  # 组装发布目录：dist + functions + 只含 D1 绑定的 wrangler.toml
  workdir="$tmp/site"
  mkdir -p "$workdir"
  cp -R "$DIST" "$workdir/dist"
  cp -R "$FUNCTIONS_DIR" "$workdir/functions"
  rm -f "$workdir/functions/schema.sql"
  cat > "$workdir/wrangler.toml" <<TOML
name = "$PROJECT"
pages_build_output_dir = "dist"
compatibility_date = "2026-11-01"

[[d1_databases]]
binding = "DB"
database_name = "$dbname"
database_id = "$dbid"
TOML
  site="dist"
fi
(cd "$workdir" && $WRANGLER pages deploy "$site" --project-name "$PROJECT" --branch main --commit-hash "$SHA" --commit-dirty=true)
echo "已发布 ${SHA:0:8} → https://$subdomain" | tee -a "$SUMMARY"
echo "deployed=$SHA"
