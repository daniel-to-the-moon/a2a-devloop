#!/usr/bin/env bash
# claude.yml publish 任务：把 work 任务产出的提交推到 claude/* 分支，并开 PR 或评论。由 claude.test.mjs 用假 gh / git 测试。
# 本脚本来自 main（可信），不检出、不执行 PR 里的任何代码。
# 输入（环境变量）：OUT（work 产物目录）、REPO、N、MODE、BRANCH、START、EVENT、RUN_URL、PUSH_URL（git 远端地址）
# 失败（任何命令非零）时由调用方的 failure() 步骤发失败说明并加 needs-user。
set -euo pipefail
mkdir -p "$OUT"
if [ ! -f "$OUT/outcome" ]; then
  # 连产物都没有（work 任务整体失败 / 超时被取消）
  echo needs-user > "$OUT/outcome"
  printf '执行者：Claude（devloop）\n\n云端执行任务失败或超时，没有产物，自动循环在此停下，请用户查看：%s\n' "$RUN_URL" > "$OUT/body.md"
fi
if [ "$(tr -d '[:space:]' < "$OUT/outcome")" != "pr" ]; then
  gh issue comment "$N" -R "$REPO" --body-file "$OUT/body.md"
  gh issue edit "$N" -R "$REPO" --add-label needs-user
  echo "published=needs-user"
  exit 0
fi
case "$BRANCH" in claude/*) ;; *) echo "::error::拒绝推送到非 claude/* 分支：$BRANCH" >&2; exit 1 ;; esac
work=$(mktemp -d)
git init -q "$work"
cd "$work"
git remote add origin "$PUSH_URL"
git fetch -q origin "$START"
git bundle verify -q "$OUT/work.bundle"
git fetch -q "$OUT/work.bundle" HEAD
new=$(git rev-parse FETCH_HEAD)
git merge-base --is-ancestor "$START" "$new" || { echo "::error::新提交不是从起点延伸的" >&2; exit 1; }
if [ "$MODE" != "fix" ]; then
  # 新分支：把新提交挪到当前 main 上再推。若 work 运行期间 main 更新了工作流文件，从旧起点开出的新分支
  # 在 GitHub 看来等于“改动工作流”，GITHUB_TOKEN 无此权限会被拒。
  # 纯 git 操作，不执行仓库代码；有冲突则失败，由 failure() 步骤报告并加 needs-user。
  git fetch -q origin main
  main=$(git rev-parse FETCH_HEAD)
  if [ "$main" != "$START" ]; then
    git checkout -q --detach "$new"
    git -c user.name=claude-devloop -c user.email=claude-devloop@users.noreply.github.com rebase -q --onto "$main" "$START" \
      || { git rebase --abort 2>/dev/null || true; echo "::error::新提交无法干净地挪到当前 main 上（有冲突）" >&2; exit 1; }
    new=$(git rev-parse HEAD)
  fi
fi
# 普通推送：分支在此期间被别人更新（非快进）则失败，不覆盖
git push -q origin "$new:refs/heads/$BRANCH"
if [ "$MODE" = "fix" ]; then
  gh pr comment "$N" -R "$REPO" --body-file "$OUT/body.md"
  # 手动重跑（workflow_dispatch）意味着用户已排除上次停下的原因：修复成功推送后去掉 needs-user，
  # 让本机审核方处理新提交。hold 是用户的暂停意图，保持不动
  if [ "${EVENT:-}" = "workflow_dispatch" ]; then
    gh pr edit "$N" -R "$REPO" --remove-label needs-user
  fi
else
  title=$(head -c 200 "$OUT/title.txt" 2>/dev/null || true)
  gh pr create -R "$REPO" --base main --head "$BRANCH" --title "${title:-devloop：issue #$N}" --body-file "$OUT/body.md"
fi
echo "published=$new"
