#!/usr/bin/env bash
# claude.yml work 任务：自己装 Bun（带重试），把路径写到 $GITHUB_OUTPUT 的 path=，交给 claude-code-action 的
# path_to_bun_executable（非空时 action 跳过内置 setup-bun）。由 claude.test.mjs 用假 npm / sleep 测试。
# 原因：action 内置 setup-bun 曾 从 GitHub 下载 Bun 连续 HTTP 504，整个任务失败；这里改从 npm 装同一版本。
# 成功判定：路径固定取本次安装的 npm 全局前缀（$(npm prefix -g)/bin/bun），不看 PATH 上可能遗留的别的 bun；
#   必须可执行，且 --version 与 BUN_VERSION 完全相等。不满足即视为本次尝试失败（不回退为空路径）。
# 环境：BUN_VERSION（默认与 action 内置版本一致 1.4.4）、ATTEMPTS（默认 3）、BACKOFF（默认 15 秒，第 i 次失败后等 i×BACKOFF）
set -euo pipefail
version="${BUN_VERSION:-1.4.4}"
attempts="${ATTEMPTS:-3}"
backoff="${BACKOFF:-15}"
got=""
for ((i = 1; i <= attempts; i++)); do
  if npm install -g --no-audit --no-fund "bun@${version}" >/dev/null 2>&1; then
    prefix=$(npm prefix -g 2>/dev/null || true)
    path="${prefix:+$prefix/bin/bun}"
    got=""
    if [ -n "$path" ] && [ -x "$path" ]; then got=$("$path" --version 2>/dev/null || true); fi
    if [ -n "$got" ] && [ "$got" = "$version" ]; then
      echo "path=$path" >> "$GITHUB_OUTPUT"
      echo "已安装 Bun $("$path" --version)：$path"
      exit 0
    fi
  fi
  echo "第 $i 次安装 Bun 失败${got:+（版本 $got，期望 $version）}"
  if [ "$i" -lt "$attempts" ]; then sleep $((backoff * i)); fi
done
echo "::error::安装 Bun 失败（npm 重试 $attempts 次）" >&2
exit 1
