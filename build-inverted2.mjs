/**
 * build-inverted2.mjs —— 倒排索引 v2：分片存储，避免 JSON.parse 整个 61 MB
 *
 * 2026-11-10 v1 实测失败：
 *   扫盘 10.2 秒 vs 查索引 3.7 秒 → 只快 2.8 倍，没到 3 倍标准。
 *   原因：JSON.parse 61 MB 本身就要 3 秒多，索引的优势全被吃掉。
 *
 * v2 改法：**按 bigram 首字分片**，查一个词只读那一片。
 *   1657 个文件、133 万 bigram，按首字（约 3000 个汉字）分片，
 *   每片平均 400 个 bigram / 约 20 KB。读一片 <10 ms。
 *
 * 产物：
 *   kb-inv2/index.json         { 首字: [offset, bytes] }  + 文件表
 *   kb-inv2/<hex>.bin          分片，内容是 JSON { bigram: [fileId...] }
 */
import fs from 'node:fs';
import path from 'node:path';

const KB = 'G:/path/to/knowledge-base';
const OLD = path.join(KB, '索引', 'kb-inverted.json');
const FILES = path.join(KB, '索引', 'kb-files.json');
const OUT = path.join(KB, '索引', 'kb-inv2');

const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'R', 'T', 'X'];

function* walk(dir, depth = 0) {
  if (depth > 5) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('_') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { yield* walk(p, depth + 1); continue; }
    if (!/\.(txt|md)$/i.test(e.name)) continue;
    yield p;
  }
}

function isCJK(ch) {
  const c = ch.codePointAt(0);
  return c >= 0x4e00 && c <= 0x9fff;
}

// ── 建表（同 v1，但只存不写全量）──
const files = [];
const inv = new Map();
const roots = [path.join(KB, '学科资料'), path.join(KB, 'MEGA核对库'),
               path.join(KB, '产出'), path.join(KB, '文档')];
const seen = new Set();

for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const f of walk(root)) {
    if (seen.has(f)) continue;
    seen.add(f);
    let t;
    try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (t.length < 500) continue;
    const idx = files.length;
    const rel = path.relative(KB, f).replace(/\\/g, '/');
    const lm = /(^|\/)(L\d|R|T|X)-/.exec(rel);
    files.push({ rel, layer: lm ? lm[2] : (rel.startsWith('MEGA核对库') ? 'MEGA' : ''), chars: t.length });

    const low = t.toLowerCase();
    const local = new Set();
    for (let i = 0; i + 1 < low.length; i++) {
      const a = low[i], b = low[i + 1];
      if (isCJK(a) && isCJK(b)) local.add(a + b);
    }
    for (const w of (low.match(/[a-zäöüß]{3,20}/g) || [])) local.add('w:' + w);

    for (const g of local) {
      if (!inv.has(g)) inv.set(g, []);
      inv.get(g).push(idx);
    }
  }
}

// ── 按首字分片 ──
fs.mkdirSync(OUT, { recursive: true });
const shards = new Map();          // key -> {bigram: [ids]}
let dropped = 0;
const hotLimit = Math.floor(files.length * 0.3);

for (const [g, arr] of inv) {
  if (arr.length > hotLimit) { dropped++; continue; }
  const key = g.startsWith('w:') ? '_w' : g[0];
  if (!shards.has(key)) shards.set(key, {});
  shards.get(key)[g] = arr;
}

const index = {};
for (const [key, obj] of shards) {
  const name = Buffer.from(key, 'utf8').toString('hex') + '.json';
  const body = JSON.stringify(obj);
  fs.writeFileSync(path.join(OUT, name), body, 'utf8');
  index[key] = { file: name, bytes: Buffer.byteLength(body) };
}

fs.writeFileSync(path.join(OUT, '_files.json'), JSON.stringify(files), 'utf8');
fs.writeFileSync(path.join(OUT, '_index.json'), JSON.stringify(index), 'utf8');

const tot = Object.values(index).reduce((s, x) => s + x.bytes, 0);
console.log(`文件 ${files.length}｜分片 ${shards.size} 片｜index 体积 ${(tot / 1024 / 1024).toFixed(1)} MB`);
console.log(`丢掉高频 ${dropped} 个 bigram`);
const sizes = Object.values(index).map((x) => x.bytes).sort((a, b) => a - b);
console.log(`单片中位 ${(sizes[sizes.length >> 1] / 1024).toFixed(1)} KB，最大 ${(sizes[sizes.length - 1] / 1024).toFixed(0)} KB`);
