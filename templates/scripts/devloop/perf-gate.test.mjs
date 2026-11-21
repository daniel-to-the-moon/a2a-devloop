// 性能验收（scripts/e2e/gates-lib.mjs）的统计与预算判定
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkBudgets, summarize } from '../e2e/gates-lib.mjs';

const frames = (n, calls, tris = 100) => Array.from({ length: n }, (_, i) => ({ calls, tris, ms: i ? 16 : 0 }));

test('summarize：中位数、最大值；第一帧不计帧时间', () => {
  const s = summarize([...frames(30, 10), ...frames(31, 20, 300)]);
  assert.equal(s.frames, 61);
  assert.equal(s.callsMedian, 20);
  assert.equal(s.callsMax, 20);
  assert.equal(s.trisMax, 300);
  assert.equal(s.msMedian, 16);
  assert.deepEqual(summarize([]), { frames: 0, callsMedian: 0, callsMax: 0, trisMedian: 0, trisMax: 0, msMedian: 0 });
});

test('checkBudgets：超预算、缺场景、帧数不足、0 draw call 都失败', () => {
  const budgets = { scenes: { home: { callsMedian: 100, callsMax: 120 }, interact: { trisMedian: 1000 } } };
  assert.deepEqual(checkBudgets({ home: summarize(frames(60, 97)), interact: summarize(frames(60, 50, 900)) }, budgets), []);
  assert.match(checkBudgets({ home: summarize(frames(60, 101)), interact: summarize(frames(60, 50)) }, budgets).join(), /home 的 callsMedian = 101，超出预算 100/);
  assert.match(checkBudgets({ home: summarize(frames(60, 97)) }, budgets).join(), /interact 没有采到数据/);
  assert.match(checkBudgets({ home: summarize(frames(10, 97)), interact: summarize(frames(60, 1)) }, budgets).join(), /只采到 10 帧/);
  assert.match(checkBudgets({ home: summarize(frames(60, 0)), interact: summarize(frames(60, 1)) }, budgets).join(), /没有任何 draw call/);
});

const budgetsFile = new URL('../e2e/budgets.json', import.meta.url);
test('budgets.json：至少一个固定场景有 draw call 预算', { skip: !existsSync(budgetsFile) && '未安装性能验收（scripts/e2e/budgets.json）' }, () => {
  const b = JSON.parse(readFileSync(budgetsFile, 'utf8'));
  assert.ok(Object.values(b.scenes ?? {}).some((s) => s.callsMedian > 0));
});
