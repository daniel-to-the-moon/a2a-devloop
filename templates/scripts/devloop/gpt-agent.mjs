#!/usr/bin/env node
/**
 * 云端 GPT 执行者：直接调 OpenAI Responses API（函数调用循环），不经 Codex。
 *
 * 为什么不用 openai/codex-action：2026-11-22 用户换成 OpenAI 官方 project key 后，Codex 报
 * codex_byok_restricted_by_api_credit_promo（该组织的额度不能用于 Codex 自带 key 调用），而 Responses API 正常。
 *
 * 两种模式：
 *   write：主设实现 / 修复（codex.yml）。工具：list_dir / read_file / search / write_file / delete_file / finish。
 *   read ：代码审核（gpt-review.yml）。工具：list_dir / read_file / search / finish（不能写）。
 * 模型只能读写 --root 之下的文件；拒绝 .git、node_modules、.github/workflows（发布令牌推不上去）与越界路径（含符号链接）。
 * 本脚本不执行仓库代码，也不给模型任何命令执行能力：依赖安装、测试与构建由工作流在之后、不持有 key 的步骤里运行。
 * finish 的参数就是结果（schema 由 --schema 给出），写到 --out。
 *
 * 用法：node gpt-agent.mjs --mode write|read --root DIR --prompt FILE --schema FILE --out FILE [--feedback FILE] [--diff-dir DIR]
 *   --diff-dir：审核用，目录里有工作流预先生成的 stat.txt / diff.patch / log.txt（模型不能跑 git），并进提示词
 * 环境：OPENAI_API_KEY；GPT_RESPONSES_ENDPOINT（完整地址，可空 = 官方）；MODEL；EFFORT（默认 high）
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const MAX_READ = 120_000; // 单次读取上限（字符），超出截断并提示用 offset 续读
const MAX_WRITE = 400_000;
const DENY = [/^\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /^\.github\/workflows(\/|$)/];

/** 把模型给的相对路径解析到 root 之内；越界、命中禁区或经符号链接逃出 root 都拒绝 */
export function safePath(root, p, { forWrite = false } = {}) {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw new Error('路径无效');
  const rootReal = realpathSync(root);
  const abs = resolve(rootReal, p);
  const rel = relative(rootReal, abs).split(sep).join('/');
  if (rel === '' && forWrite) throw new Error('不能写仓库根目录');
  if (rel.startsWith('..') || resolve(rootReal, rel) !== abs) throw new Error(`路径越界：${p}`);
  if (DENY.some((re) => re.test(rel))) throw new Error(`不允许访问：${rel}`);
  // 逐级检查已存在的部分：任何一级是符号链接且指向 root 之外 → 拒绝；写入时不允许写到符号链接上
  let cur = rootReal;
  for (const part of rel ? rel.split('/') : []) {
    cur = join(cur, part);
    if (!existsSync(cur) && !isLink(cur)) break;
    if (isLink(cur)) {
      if (forWrite) throw new Error(`不允许经符号链接写入：${rel}`);
      checkReal(rootReal, realpathSync(cur), rel);
    }
  }
  // 最终目标（若存在）也按真实路径再查一遍禁区：仓库内的链接（如 alias -> .git）不能绕过 DENY
  if (existsSync(abs)) checkReal(rootReal, realpathSync(abs), rel);
  return { abs, rel: rel || '.' };
}

function checkReal(rootReal, real, rel) {
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new Error(`符号链接指向仓库外：${rel}`);
  const realRel = relative(rootReal, real).split(sep).join('/');
  if (DENY.some((re) => re.test(realRel))) throw new Error(`不允许访问：${rel}（实际指向 ${realRel}）`);
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function walk(root, dir, out, limit) {
  for (const name of readdirSync(dir).sort()) {
    if (out.length >= limit) return;
    const abs = join(dir, name);
    const rel = relative(root, abs).split(sep).join('/');
    if (DENY.some((re) => re.test(rel)) || isLink(abs)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) walk(root, abs, out, limit);
    else if (st.isFile() && st.size <= 2_000_000) out.push({ abs, rel });
  }
}

export function makeTools(root, mode) {
  const rootReal = realpathSync(root);
  const changed = new Set();
  const tools = {
    list_dir: {
      description: '列出目录内容（相对仓库根目录；"." 是根目录）。目录名以 / 结尾。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      run: ({ path }) => {
        const { abs, rel } = safePath(rootReal, path);
        // 按真实路径过滤：经仓库内链接（如 alias -> .）列目录时，禁区同样不出现
        const realRel = relative(rootReal, realpathSync(abs)).split(sep).join('/');
        return readdirSync(abs)
          .sort()
          .filter((n) => !DENY.some((re) => re.test(realRel === '' ? n : `${realRel}/${n}`)))
          .map((n) => (statSync(join(abs, n)).isDirectory() ? `${n}/` : n))
          .join('\n') || '（空目录）';
      },
    },
    read_file: {
      description: `读取文本文件。单次最多 ${MAX_READ} 字符，可用 offset（字符偏移）续读。`,
      parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' } }, required: ['path'], additionalProperties: false },
      run: ({ path, offset = 0 }) => {
        const { abs } = safePath(rootReal, path);
        const text = readFileSync(abs, 'utf8');
        const part = text.slice(offset, offset + MAX_READ);
        return offset + MAX_READ < text.length ? `${part}\n…（已截断：共 ${text.length} 字符，下次从 offset=${offset + MAX_READ} 继续）` : part;
      },
    },
    search: {
      description: '在仓库文本文件里搜索正则（JavaScript 语法），返回“路径:行号: 内容”，最多 200 条。path 可限定子目录。',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'], additionalProperties: false },
      run: ({ pattern, path = '.' }) => {
        const re = new RegExp(pattern);
        const { abs } = safePath(rootReal, path);
        const files = [];
        // 从真实路径起遍历（walk 不跟随链接），这样递归访问到的每个文件都按真实路径查 DENY（GPT 审核 #76）
        if (statSync(abs).isDirectory()) walk(rootReal, realpathSync(abs), files, 5000);
        else files.push({ abs, rel: relative(rootReal, abs).split(sep).join('/') });
        const hits = [];
        for (const f of files) {
          let text;
          try {
            text = readFileSync(f.abs, 'utf8');
          } catch {
            continue;
          }
          if (text.includes('\0')) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.length < 200; i++) if (re.test(lines[i])) hits.push(`${f.rel}:${i + 1}: ${lines[i].slice(0, 300)}`);
          if (hits.length >= 200) break;
        }
        return hits.join('\n') || '（无匹配）';
      },
    },
  };
  if (mode === 'write') {
    tools.write_file = {
      description: '写入（新建或整体覆盖）文本文件，需要时自动建目录。给出文件的完整新内容。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
      run: ({ path, content }) => {
        if (typeof content !== 'string' || content.length > MAX_WRITE) throw new Error(`内容缺失或超过 ${MAX_WRITE} 字符`);
        const { abs, rel } = safePath(rootReal, path, { forWrite: true });
        mkdirSync(dirname(abs), { recursive: true });
        safePath(rootReal, path, { forWrite: true }); // 建目录后再查一次（防目录竞态 / 链接）
        writeFileSync(abs, content);
        changed.add(rel);
        return `已写入 ${rel}（${content.length} 字符）`;
      },
    };
    tools.delete_file = {
      description: '删除一个文件。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      run: ({ path }) => {
        const { abs, rel } = safePath(rootReal, path, { forWrite: true });
        if (!statSync(abs).isFile()) throw new Error('只能删除文件');
        rmSync(abs);
        changed.add(rel);
        return `已删除 ${rel}`;
      },
    };
  }
  return { tools, changed };
}

export function endpoint(env) {
  return env.GPT_RESPONSES_ENDPOINT || 'https://api.openai.com/v1/responses';
}

/**
 * 函数调用循环。finish 的参数即结果；没调 finish 就用完轮次 / 时限 → 抛错（工作流转 needs-user）。
 * fetchImpl / now 便于测试。
 */
export async function runAgent({ mode, root, prompt, schema, env, diffText = null, fetchImpl = fetch, maxTurns = 80, deadlineMs = 60 * 60_000, now = Date.now, sleep = (ms) => new Promise((res) => setTimeout(res, ms)), log = () => {} }) {
  const { tools, changed } = makeTools(root, mode);
  // 审核：完整 diff 只读、可分页（提示词里过长会截断；仓库检出里看不到删除的文件和行，Codex 审核 #76 P2）
  if (diffText != null)
    tools.read_diff = {
      description: `分页读取本 PR 的完整 diff（工作流预生成，共 ${diffText.length} 字符），单次最多 ${MAX_READ} 字符。`,
      parameters: { type: 'object', properties: { offset: { type: 'integer' } }, required: ['offset'], additionalProperties: false },
      run: ({ offset = 0 }) => {
        const part = diffText.slice(offset, offset + MAX_READ);
        return offset + MAX_READ < diffText.length ? `${part}\n…（未完：下次从 offset=${offset + MAX_READ} 继续）` : part || '（已到末尾）';
      },
    };
  const defs = [
    ...Object.entries(tools).map(([name, t]) => ({ type: 'function', name, description: t.description, parameters: t.parameters, strict: false })),
    { type: 'function', name: 'finish', description: '完成任务时调用一次，参数就是最终结果。调用后不再有后续。', parameters: schema, strict: false },
  ];
  const url = endpoint(env);
  const deadline = now() + deadlineMs;
  let input = [{ role: 'user', content: prompt }];
  let previous;
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (now() > deadline) throw new Error('超出总时限');
    const body = { model: env.MODEL, input, tools: defs, reasoning: { effort: env.EFFORT || 'high' }, ...(previous ? { previous_response_id: previous } : {}) };
    const r = await call(fetchImpl, url, env, body, { deadline, now, sleep });
    previous = r.id;
    const calls = (r.output ?? []).filter((o) => o.type === 'function_call');
    if (!calls.length) {
      input = [{ role: 'user', content: '请用工具继续；完成时调用 finish 给出结果。' }];
      continue;
    }
    input = [];
    for (const c of calls) {
      let args;
      try {
        args = JSON.parse(c.arguments || '{}');
      } catch {
        input.push({ type: 'function_call_output', call_id: c.call_id, output: '错误：参数不是合法 JSON' });
        continue;
      }
      if (c.name === 'finish') {
        log(`第 ${turn} 轮：finish`);
        return { result: args, changed: [...changed], turns: turn, usage: r.usage ?? null };
      }
      const t = tools[c.name];
      let out;
      try {
        if (!t) throw new Error(`没有这个工具：${c.name}`);
        out = String(t.run(args));
      } catch (e) {
        out = `错误：${e.message}`;
      }
      log(`第 ${turn} 轮：${c.name} ${JSON.stringify(args.path ?? args.pattern ?? '').slice(0, 120)}`);
      input.push({ type: 'function_call_output', call_id: c.call_id, output: out });
    }
  }
  throw new Error(`${maxTurns} 轮内没有调用 finish`);
}

/**
 * 一次模型请求，网络错误 / 429 / 5xx 最多试 3 次。每次请求、退避前与接受结果前都按绝对截止时间 deadline 检查，
 * 请求超时与退避时长都不超过剩余时间（GPT 审核 #76：重试不能越过总时限）。
 */
async function call(fetchImpl, url, env, body, { deadline, now, sleep }) {
  const left = () => deadline - now();
  const over = () => new Error('超出总时限');
  const backoff = async (ms) => {
    if (left() <= ms) throw over();
    await sleep(ms);
  };
  for (let i = 1; ; i++) {
    if (left() <= 0) throw over();
    let r, text;
    try {
      r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY ?? ''}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, Math.min(left(), 15 * 60_000))),
      });
      text = await r.text();
    } catch (e) {
      if (left() <= 0) throw over();
      if (i < 3) {
        await backoff(10_000 * i);
        continue;
      }
      throw new Error(`连不上 ${new URL(url).host}：${e.cause?.code || e.message}`);
    }
    if (left() <= 0) throw over();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {}
    if (r.ok) return json;
    if ((r.status === 429 || r.status >= 500) && i < 3) {
      await backoff(15_000 * i);
      continue;
    }
    throw new Error(`HTTP ${r.status}：${JSON.stringify(json.error ?? text).slice(0, 300)}`);
  }
}

const MAX_DIFF = 200_000;

/** 审核提示词里“用 `git diff …` 查看完整改动”换成预生成的改动（模型不能跑命令）；过长则截断并提示用 read_file 读文件 */
export function withDiff(prompt, { stat = '', diff = '', log = '' }) {
  const lines = prompt.split('\n');
  const i = lines.findIndex((l) => l.startsWith('用 `git diff '));
  if (i < 0) throw new Error('审核提示词里找不到“用 `git diff …` 查看完整改动”这一行');
  lines[i] = '完整改动已由工作流预先生成，附在本提示词末尾（你不能运行命令）；需要上下文时用 read_file / search 阅读 PR 头部提交的检出。测试与构建由 CI 在合并后的代码上另行执行，你只需审代码。审完调用 finish 给出结论。';
  const cut = diff.length > MAX_DIFF;
  return [lines.join('\n'), '', '## 提交记录', '', '```', log.trim(), '```', '', '## 改动统计', '', '```', stat.trim(), '```', '', `## 完整 diff${cut ? `（过长，这里只附前 ${MAX_DIFF} 字符；必须用 read_diff 从 offset=${MAX_DIFF} 读完剩下的部分再下结论）` : ''}`, '', '```diff', cut ? diff.slice(0, MAX_DIFF) : diff, '```'].join('\n');
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const mode = arg('mode');
  if (!['write', 'read'].includes(mode)) throw new Error('--mode 只能是 write 或 read');
  let prompt = readFileSync(arg('prompt'), 'utf8');
  const fb = arg('feedback');
  if (fb && existsSync(fb)) prompt += `\n\n## 上一轮改动没有通过把关（npm test / npm run build），日志末尾如下。请在现有改动基础上修好，再调用 finish：\n\n\`\`\`\n${readFileSync(fb, 'utf8').slice(-12000)}\n\`\`\`\n`;
  const dd = arg('diff-dir');
  const ctx = dd ? Object.fromEntries(['stat', 'diff', 'log'].map((k) => [k, readFileSync(join(dd, k === 'diff' ? 'diff.patch' : `${k}.txt`), 'utf8')])) : null;
  if (ctx) prompt = withDiff(prompt, ctx);
  const schema = JSON.parse(readFileSync(arg('schema'), 'utf8'));
  const r = await runAgent({ mode, root: arg('root'), prompt, schema, env: process.env, diffText: ctx?.diff ?? null, log: (m) => console.log(m) });
  writeFileSync(arg('out'), JSON.stringify(r.result, null, 2));
  console.log(`完成：${r.turns} 轮；改动文件：${r.changed.join('、') || '无'}；用量：${JSON.stringify(r.usage)}`);
}
