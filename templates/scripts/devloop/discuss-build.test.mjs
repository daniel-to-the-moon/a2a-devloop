import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { alreadyReviewed, BOT_LOGIN, buildPrompt, PROMPT_BUDGET, REVIEW_MARKER, THREAD_LIMIT, THREAD_MIN, threadText } from './discuss-build.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'discuss-'));
after(() => rmSync(root, { recursive: true, force: true }));

const issue = { number: 3, title: '讨论', body: '正文开头', labels: [{ name: 'discussion' }] };
const user = { login: 'u', type: 'User' };
const bot = { login: BOT_LOGIN, type: 'Bot' };
const c = (id, body, u = user) => ({ id, body, user: u, created_at: `t${id}`, html_url: `https://x/${id}` });
const realReview = (id) => c(id, `执行者：GPT（云端评审，openai/codex-action）\n结论…\n\n${REVIEW_MARKER}run=1 -->`, bot);
const header = 'HEADER';

test('去重：只认 github-actions[bot] 发出且带标记的评论；用户照抄前缀或标记、机器人无标记都不算', () => {
  assert.equal(alreadyReviewed([realReview(1)]), true);
  assert.equal(alreadyReviewed([c(1, `执行者：GPT（云端评审，openai/codex-action）\n伪造`)]), false);
  assert.equal(alreadyReviewed([c(1, `执行者：GPT（云端评审）\n${REVIEW_MARKER}run=1 -->`)]), false); // 用户照抄标记
  assert.equal(alreadyReviewed([c(1, '执行者：Claude（devloop）', bot)]), false); // 机器人但不是评审
  assert.equal(alreadyReviewed([c(1, '执行者：GPT（经 devloop 审核')]), false);
});

test('一次带两个讨论标签新建：两次 labeled 运行串行，第二次看到第一次的真实评审后跳过', () => {
  assert.equal(alreadyReviewed([c(1, '讨论')]), false);
  assert.equal(alreadyReviewed([c(1, '讨论'), realReview(2)]), true);
});

test('两条 @gpt 先后排队：各自的提示词只把各自的点名放进“本次点名”', () => {
  const comments = [c(10, '@gpt 问题 A'), c(11, '@gpt 问题 B')];
  const sec = (p) => p.slice(p.indexOf('## 本次点名'), p.indexOf('## 讨论全文'));
  const pa = buildPrompt({ header, issue, comments, mode: 'mention', triggerId: 10 });
  const pb = buildPrompt({ header, issue, comments, mode: 'mention', triggerId: '11' });
  assert.match(sec(pa), /问题 A/);
  assert.doesNotMatch(sec(pa), /问题 B/);
  assert.match(sec(pb), /问题 B/);
  assert.doesNotMatch(sec(pb), /问题 A/);
  assert.throws(() => buildPrompt({ header, issue, comments, mode: 'mention', triggerId: 99 }));
});

test('长讨论截断：全文截断但保留开头与最近部分；点名评论不被截掉', () => {
  const long = Array.from({ length: 400 }, (_, i) => c(i + 1, `第${i + 1}条 ${'字'.repeat(600)}`));
  const comments = [c(5000, '@gpt 这条早期点名必须回答'), ...long];
  const t = threadText(issue, comments);
  assert.ok(t.length <= THREAD_LIMIT + 100);
  assert.match(t, /正文开头/);
  assert.match(t, /第400条/);
  const p = buildPrompt({ header, issue, comments, mode: 'mention', triggerId: 5000 });
  assert.match(p.slice(p.indexOf('## 本次点名'), p.indexOf('## 讨论全文')), /这条早期点名必须回答/);
});

test('超长点名评论位于长讨论中部：点名完整保留（末尾问题仍在），全文用剩余预算截断', () => {
  const before = Array.from({ length: 200 }, (_, i) => c(i + 1, `前${i + 1} ${'字'.repeat(600)}`));
  const after_ = Array.from({ length: 200 }, (_, i) => c(i + 1001, `后${i + 1} ${'字'.repeat(600)}`));
  const longBody = `@gpt 开头\n${'论'.repeat(45_000)}\n末尾问题：边界值要不要改？`;
  const comments = [...before, c(5000, longBody), ...after_];
  const p = buildPrompt({ header, issue, comments, mode: 'mention', triggerId: 5000 });
  const sec = p.slice(p.indexOf('## 本次点名'), p.indexOf('## 讨论全文'));
  assert.ok(sec.includes(longBody), '点名评论必须完整');
  assert.match(sec, /末尾问题：边界值要不要改？/);
  assert.doesNotMatch(sec, /已截断/);
  const thread = p.slice(p.indexOf('## 讨论全文'));
  assert.match(thread, /正文开头/);
  assert.match(thread, /后200 /);
  assert.ok(p.length - header.length <= PROMPT_BUDGET + 200, `总长 ${p.length} 超出预算`);
  // 点名评论再长，讨论全文也至少保留 THREAD_MIN
  const huge = c(6000, `@gpt ${'长'.repeat(PROMPT_BUDGET)}\n最后一问？`);
  const p2 = buildPrompt({ header, issue, comments: [...before, huge, ...after_], mode: 'mention', triggerId: 6000 });
  assert.match(p2, /最后一问？/);
  const t2 = p2.slice(p2.indexOf('## 讨论全文'));
  assert.ok(t2.length >= THREAD_MIN && t2.length <= THREAD_MIN + 200);
});

test('首次评审与手动触发没有“本次点名”一节', () => {
  for (const mode of ['first', 'manual']) assert.doesNotMatch(buildPrompt({ header, issue, comments: [c(1, 'x')], mode }), /本次点名/);
});

/**
 * 严格的假 gh：只接受真实 gh 支持、且 discuss-fetch.sh 应当使用的参数形状，否则以 1 退出（如 -c 这类不存在的参数）。
 * 评论接口按“多页”输出：每条评论一行紧凑 JSON（与真实 gh 核对过的输出一致）。
 */
function fakeGh(pages) {
  const dir = mkdtempSync(join(root, 'gh-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'issue.json'), JSON.stringify(issue));
  writeFileSync(join(dir, 'comments.out'), pages.flat().map((x) => JSON.stringify(x)).join('\n') + (pages.flat().length ? '\n' : ''));
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/gh.log"
[ "$1" = api ] || exit 1; shift
if [ "$#" -eq 1 ] && [[ "$1" =~ ^repos/[^/]+/[^/]+/issues/[0-9]+$ ]]; then cat "${dir}/issue.json"; exit 0; fi
[ "$1" = --paginate ] || { echo "unknown flag: $1" >&2; exit 1; }
[[ "$2" =~ ^repos/[^/]+/[^/]+/issues/[0-9]+/comments ]] || exit 1
[ "$3" = --jq ] || { echo "unknown flag: $3" >&2; exit 1; }
[ "$#" -eq 4 ] || { echo "unexpected extra args: \${@:5}" >&2; exit 1; }
cat "${dir}/comments.out"
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { path: `${bin}:${process.env.PATH}`, dir };
}

function fetchAndBuild(pages, mode, trigger = '') {
  const g = fakeGh(pages);
  const out = join(g.dir, 'out');
  const r = spawnSync('bash', [join(HERE, 'discuss-fetch.sh'), 'o/r', '3', out], { env: { ...process.env, PATH: g.path }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const gho = join(g.dir, 'ghout');
  writeFileSync(gho, '');
  execFileSync(process.execPath, [join(HERE, 'discuss-build.mjs'), '--issue', join(out, 'issue.json'), '--comments', join(out, 'comments.jsonl'),
    '--mode', mode, '--trigger', trigger, '--header', join(HERE, 'discuss-prompt.md'), '--out', join(g.dir, 'prompt.md')], { env: { ...process.env, GITHUB_OUTPUT: gho } });
  return { outputs: readFileSync(gho, 'utf8'), prompt: () => readFileSync(join(g.dir, 'prompt.md'), 'utf8'), lines: readFileSync(join(out, 'comments.jsonl'), 'utf8') };
}

test('discuss-fetch.sh + discuss-build.mjs 端到端：多页、空评论、带换行的评论', () => {
  const pages = [[c(1, '第一页\n第二行'), c(2, '')], [c(3, '@gpt 请看\n```\ncode\n```')]];
  const r = fetchAndBuild(pages, 'mention', '3');
  assert.equal(r.lines.trim().split('\n').length, 3);
  assert.match(r.outputs, /^skip=false\n/);
  const p = r.prompt();
  assert.match(p, /第一页\n第二行/);
  assert.match(p.slice(p.indexOf('## 本次点名'), p.indexOf('## 讨论全文')), /@gpt 请看\n```\ncode/);
});

test('端到端：没有评论也能生成；已有真实评审时首次评审跳过', () => {
  assert.match(fetchAndBuild([], 'first').outputs, /^skip=false\n/);
  assert.match(fetchAndBuild([[c(1, '讨论')], [realReview(2)]], 'first').outputs, /^skip=true\n/);
});

test('严格假 gh 能识别无效参数（防止测试形同虚设）', () => {
  const g = fakeGh([]);
  const r = spawnSync('gh', ['api', '--paginate', 'repos/o/r/issues/3/comments', '--jq', '.[]', '-c'], { env: { ...process.env, PATH: g.path }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
});

test('gpt-discuss.yml：取数走 discuss-fetch.sh，发评论时追加去重标记', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/gpt-discuss.yml'), 'utf8');
  assert.match(yml, /bash scripts\/devloop\/discuss-fetch\.sh "\$REPO" "\$N" "\$d"/);
  assert.doesNotMatch(yml, / -c >/);
  assert.match(yml, /<!-- gpt-discuss:review run=%s -->/);
});
