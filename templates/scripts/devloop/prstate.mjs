/**
 * 读取 PR 状态（含审核方签名标记）。从 devloop.mjs 拆出，便于用假 gh 测试整条查询链路。
 *
 * 审核方账号每次读取都重新查询（`gh api user`），不在启动时缓存：
 * GitHub 账号改名后，历史评论的作者也显示为新用户名；若缓存旧名，审核方会认不出自己的签名标记，
 * 对同一提交反复评论并重复触发云端修复（真实发生过）。
 */
import { parseMarkers } from './policy.mjs';
import { CLOUD_REVIEWER_LOGINS } from './review-format.mjs';

const FIELDS = 'title,body,headRefOid,headRefName,isCrossRepository,baseRefName,state,isDraft,mergeable,labels,comments';

/**
 * gh(args) → stdout 字符串：原样执行 gh（不自动追加 -R）。
 * files：改动涉及的全部路径，含重命名前的旧路径（REST previous_filename）——`gh pr view --json files` 只给新路径，
 * 会漏掉“把 .github/workflows/x.yml 移出目录”这类改动。
 * 返回 prState(pr)：每次调用都重新查询审核方登录名与 PR。
 */
export function createPrState({ gh, repo, key, whoami = () => gh(['api', 'user', '-q', '.login']).trim() }) {
  return function prState(pr) {
    const m = JSON.parse(gh(['pr', 'view', String(pr), '--json', FIELDS, '-R', repo]));
    // 本机：每次重新查询当前登录名；云端（GITHUB_TOKEN 无法查 user）：调用方传入 whoami
    const reviewer = whoami();
    const comments = m.comments.map((c) => ({ author: c.author?.login ?? '', body: c.body }));
    // 本机审核方（当前登录账号）与云端审核（github-actions）的签名标记都认：两者共用同一把签名密钥
    const reviewers = [reviewer, ...CLOUD_REVIEWER_LOGINS];
    const files = gh(['api', '--paginate', `repos/${repo}/pulls/${pr}/files?per_page=100`, '--jq', '.[] | .filename, (.previous_filename // empty)'])
      .split('\n').map((l) => l.trim()).filter(Boolean);
    return { ...m, files, labels: m.labels.map((l) => l.name), markers: parseMarkers(comments, { key, reviewer: reviewers, pr }) };
  };
}
