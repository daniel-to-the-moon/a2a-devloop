/**
 * auto 模式轮次用满合并后的遗留意见 issue：幂等创建（本机 devloop.mjs 与云端 cloud.mjs 共用）。
 *
 * - 每条意见有稳定标识 key = pr + 审核 head + 序号，写进 issue 正文的标记 <!-- devloop-followup key=… -->；
 * - 创建前先列出已有 devloop issue（REST 列表，强一致，不用有索引延迟的搜索）查标记，已存在就复用；
 * - issue create 不是幂等的：失败（可能服务端已创建、只是响应丢了）后先重新核对远端，再决定是否重试；
 * - 本机把待办清单落盘，合并后的评论或某条 issue 失败都不丢：下一轮 watch 继续补齐（已合并的 PR 不会再被扫描）。
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { followUpIssues } from './review-format.mjs';

export const FOLLOWUP_MARK = '<!-- devloop-followup key=';

export function followUpItems({ pr, head, findings }) {
  return followUpIssues({ pr, head, findings }).map((it, i) => {
    const key = `pr${pr}-${String(head).slice(0, 12)}-${i + 1}`;
    return { key, title: it.title, body: `${it.body}\n\n${FOLLOWUP_MARK}${key} -->` };
  });
}

/** 从 issue 列表（[{ number, body }]）里找带某个 key 标记的 issue 编号 */
export function findByKey(issues, key) {
  const want = `${FOLLOWUP_MARK}${key} -->`;
  return issues.find((x) => String(x.body ?? '').includes(want))?.number ?? null;
}

/**
 * io：{ list(): [{number, body}]（打开与关闭的 devloop issue）, create(item): 返回输出（含 /issues/<n>）, sleep(ms) }
 * 返回 { numbers: { key: n }, created: [n…], failed: [{ key, err }] }；绝不对同一 key 创建两个 issue（在 list 可信的前提下）。
 */
export async function ensureFollowUps(items, io, { attempts = 3, delayMs = 5000 } = {}) {
  const numbers = {};
  const created = [];
  const failed = [];
  for (const it of items) {
    let n = null;
    let err = '';
    for (let i = 0; i < attempts && n === null; i++) {
      try {
        n = findByKey(await io.list(), it.key);
        if (n !== null) break;
      } catch (e) {
        err = `查询已有 issue 失败：${String(e.message).split('\n')[0]}`;
        if (i < attempts - 1) await io.sleep(delayMs * (i + 1));
        continue; // 查不到远端状态就不创建，避免重复
      }
      try {
        const out = String(await io.create(it));
        const m = /\/issues\/(\d+)\s*$/.exec(out.trim());
        if (m) {
          n = Number(m[1]);
          created.push(n);
          break;
        }
        err = `无法识别新 issue 编号：${out.slice(0, 80)}`;
      } catch (e) {
        err = String(e.message).split('\n')[0];
      }
      if (i < attempts - 1) await io.sleep(delayMs * (i + 1)); // 下一次先重新核对远端，再决定是否创建
    }
    if (n === null) failed.push({ key: it.key, err });
    else numbers[it.key] = n;
  }
  return { numbers, created, failed };
}

/**
 * 本机待办清单：dir/pr-<N>.json = { pr, items, flagged? }。逐个补开 issue；全部开齐才发清单评论并删除文件，
 * 否则保留到下一轮（首次失败给 PR 加 needs-user，让用户看得见）。
 * io：ensureFollowUps 的 io + { comment(pr, text), flag(pr), log(msg) }
 * acquire()：进程间互斥锁，返回 release 或 null（忙）；默认不加锁（调用方已持锁）
 */
export async function drainPending({ dir, io, opts, acquire = async () => () => {} }) {
  if (!existsSync(dir)) return;
  // 读取清单、查询远端、创建、清理全程持有进程间互斥锁：两个处理者交错时同一 key 只会创建一次。
  // 拿不到锁（另一个进程正在审核或补开）就跳过本轮，下一轮再补。调用方已持锁时传入空操作的 acquire。
  const release = await acquire();
  if (!release) return;
  try {
    await drainLocked({ dir, io, opts });
  } finally {
    await release();
  }
}

async function drainLocked({ dir, io, opts }) {
  for (const name of readdirSync(dir).filter((n) => /^pr-\d+\.json$/.test(n))) {
    const file = join(dir, name);
    const { pr, items, flagged } = JSON.parse(readFileSync(file, 'utf8'));
    const r = await ensureFollowUps(items, io, opts);
    if (r.failed.length) {
      io.log(`#${pr} 遗留意见 issue 有 ${r.failed.length} 条未开成功，下一轮继续：${r.failed.map((f) => f.err).join('；')}`);
      if (!flagged) {
        try {
          io.flag(pr);
          writeFileSync(file, JSON.stringify({ pr, items, flagged: true }));
        } catch { /* 尽力 */ }
      }
      continue;
    }
    try {
      io.comment(pr, `执行者：devloop\n\n遗留意见已转为 devloop issue：${Object.values(r.numbers).map((n) => `#${n}`).join('、')}`);
    } catch { /* 清单评论尽力而为；issue 已开齐 */ }
    rmSync(file, { force: true });
  }
}
