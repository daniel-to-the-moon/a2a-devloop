#!/usr/bin/env bash
# claude.yml work 任务：自己装 Bun（带重试），把路径写到 $GITHUB_OUTPUT 的 path=，交给 claude-code-action 的
# path_to_bun_executable（非空时 action 跳过内置 setup-bun）。由 claude.test.mjs 用假 npm / sleep 测试。
# 原因：action 内置 setup-bun 曾 从 GitHub 下载 Bun 连续 HTTP 504，整个任务失败；这里改从 npm 装同一版本。
# 环境：BUN_VERSION（默认与 action 内置版本一致 1.4.4）、ATTEMPTS（默认 3）、BACKOFF（默认 15 秒，第 i 次失败后等 i×BACKOFF）
set -euo pipefail
version="${BUN_VERSION:-1.4.4}"
attempts="${ATTEMPTS:-3}"
backoff="${BACKOFF:-15}"
for ((i = 1; i <= attempts; i++)); do
  if npm install -g --no-audit --no-fund "bun@${version}" >/dev/null 2>&1; then
    path=$(command -v bun || true)
    if [ -n "$path" ] && "$path" --version >/dev/null 2>&1; then
      echo "path=$path" >> "$GITHUB_OUTPUT"
      echo "已安装 Bun $("$path" --version)：$path"
      exit 0
    fi
  fi
  echo "第 $i 次安装 Bun 失败"
  if [ "$i" -lt "$attempts" ]; then sleep $((backoff * i)); fi
done
echo "::error::安装 Bun 失败（npm 重试 $attempts 次）" >&2
exit 1
