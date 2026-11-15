#!/usr/bin/env node
/**
 * quote.mjs —— 引文定位器（配套 kb.mjs 的「原著优先」）
 *
 * 和 kb.mjs 的区别：
 *   kb.mjs   搜全库，回答「哪份文件讲了这个」
 *   quote.mjs 只搜原文目录，回答「这句话在《哪卷》第几页，原句是什么」
 *
 * 用法：
 *   node quote.mjs 异化劳动
 *   node quote.mjs "哲学家们只是用不同的方式解释世界"
 *   node quote.mjs -n 8 商品拜物教
 *   node quote.mjs --book 文集05 剩余价值
 *   node quote.mjs --exact "无论哪一个社会形态"     只给原句，不要上下文
 *   node quote.mjs --loose 人的本质                 放宽：允许只命中拆开的词（会掺噪音）
 *   node quote.mjs --json 人的本质                   机器可读，供其他脚本接
 *   node quote.mjs --with-t 新民主主义               额外附上教材（T 层）命中
 *   node quote.mjs --with-r 唯物史观                 额外附上辞典（R 层）命中
 *
 * 关于 --with-r（2026-11-11 加，实测踩出来的）：
 *   R 层（辞书）排最后。查高频词时命中上百份，辞典永远挤不进展示列表——
 *   实测「唯物史观」命中 109 份、展示 60 条，四本辞典一条都看不见；
 *   而「延安整风」命中 32 份，四本辞典全在。
 *   高频词恰恰最需要辞典的定义，所以给一个显式开关把辞典挑出来附在末尾。
 *   注意：辞典是二手（别人怎么讲），引用纪律上不能当原文引。
 *
 * v1.1（2026-11-09，实测踩出来的）：
 *   默认改成**整串命中**。原实现按 bigram 拆词，搜「异化劳动」时拆成
 *   异化/化劳/劳动，于是《列宁全集》里任何含「劳动」的行都算命中——
 *   第 2、3 名全是无关段落。现在要求「异化劳动」这个串真的出现；
 *   OCR 会把一句断成两行，所以再拼「上一行+本行」做一次检测，跨行也能中。
 *   要模糊匹配就显式加 --loose。
 *
 * 输出体例（就是为了让引用能直接抄）：
 *   《马克思恩格斯文集》第1卷 · p176
 *     「……」
 *   —— 命中文件：学科资料/原著原文/文集01-...txt
 *
 * 设计约束（别改）：
 *   1. 只读 原著原文/ 与 教材原文/，不掺二手笔记。引用的落点只能是原文。
 *   2. 页码只从【pN】标记里取；【p?|pdfN】的段只报 PDF 页序号，不写任何页码（宁无不假）。
 *   3. 不猜、不补、不润色原句。抽出来什么样就是什么样（含 OCR 错字）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const ROOT = "G:/path/to/knowledge-base/学科资料";
// 五层（2026-11-09）。层号越小，引用地位越高；输出按层排序，不混。
// 教材单独一档：有页码但不是原著，不能排在 L0/L1 前面。
const LAYERS = [
  { prefix: "L0-", kind: "L0 马恩列原著" },
  { prefix: "L1-", kind: "L1 中国化马克思主义" },
  { prefix: "L2-", kind: "L2 西方马克思主义" },
  { prefix: "L3-", kind: "L3 相邻理论家" },
  { prefix: "L4-", kind: "L4 苏东与经典阐释" },
  { prefix: "L5-", kind: "L5 其他/反面观点" },
  // 教材单列，排在五层之后（2026-11-09 事故：教材曾被误放进 L0，
  // 结果《马发史》p322 引用毛泽东的话，压过《矛盾论》原文排第一。
  // 教材是「别人怎么讲」，原文是「本人怎么讲」——排序必须体现这个差别）
  { prefix: "T-", kind: "T 教材（非原著）" },
  // 2026-11-09 新增：用户指定要补的辞书与党史两类。
  // **必须加进 LAYERS 才会被扫描**——只改 layerRank 不够，
  // 第一版只改排序函数，结果 X 层建好了却搜不到（实测「正确党史观」查无）。
  { prefix: "R-", kind: "R 辞书与工具书" },
  { prefix: "X-", kind: "X 党史与专题" },
  // 2026-11-13 新增：M 毛泽东古籍批注。
  //   犬子下了毛泽东推荐/批注的古籍，分四级（点名送人 / 大字本86篇 /
  //   反复批读 / 随笔杂览）加点评研究。
  //   **必须加进 LAYERS 才会被扫描**——这条坑 2026-11-09 已经在 X 层踩过一次。
  //   排在 L5 之前：古籍是原文（本人怎么讲），不是研究二手。
  { prefix: "M-", kind: "M 毛泽东古籍批注" },
  // 2026-11-11 新增：论文三层。
  //   P1 马理论 / P2 法学 / P3 政治经济学
  //   为什么分开：
  //     周黎安那 6 篇是政治经济学的实证研究（晋升锦标赛、行政发包制），
  //     跟马理论不是一路。放一起查「五形态」会混进地方政府治理。
  //     法学同理（习惯法、礼刑时代）。
  //   为什么都排在最后：
  //     论文是**研究文献**，是「别人怎么讲」，不是「本人怎么讲」。
  //     混进 L0/L1 会污染「原著优先」排序——查「异化劳动」时，
  //     一篇研究异化劳动的论文会挤掉《1844年手稿》原文。
  //   引用纪律：只能写「某某认为」，不能当原文引。文件头已写死这句。
  //   ★ 必须加进 LAYERS 才会被扫描（同 R/X 的教训）。
  { prefix: "P1-", kind: "P1 论文·马理论" },
  { prefix: "P2-", kind: "P2 论文·法学" },
  { prefix: "P3-", kind: "P3 论文·政治经济学" },
];
const DIRS = LAYERS.map(l => ({ dir: join(ROOT, findLayerDir(l.prefix)), kind: l.kind }))
  .filter(d => d.dir);

function findLayerDir(prefix) {
  try {
    const hit = readdirSync(ROOT, { withFileTypes: true })
      .find(e => e.isDirectory() && e.name.startsWith(prefix));
    return hit ? hit.name : null;
  } catch { return null; }
}

const argv = process.argv.slice(2);
let limit = 5, bookFilter = null, exactOnly = false, loose = false, asJson = false, maxChars = 160, gbMode = false;
// 2026-11-10：--with-t 额外附上教材命中。
//   事故：查「新民主主义」前 30 条全是 L1/X，教材一条不出现——
//   因为 T 层 layerRank=80（永远最后），而默认只显示前 N 条。
//   但用户要的是「原著与教材对照」，教材不出现就等于没有。
//   默认行为不变（教材仍排最后），加这个开关才追加。
let withT = false;
// 2026-11-11：--with-r 额外附上辞典（R 层）。理由见下方 withR 使用处。
let withR = false;
// 2026-11-12：--with-mega 附上 MEGA2 参照线索（只报卷号，不贴德文原文）。
let withMega = false;
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-n") limit = parseInt(argv[++i], 10) || 5;
  else if (a === "--book") bookFilter = argv[++i];
  else if (a === "--exact") exactOnly = true;
  else if (a === "--loose") loose = true;
  else if (a === "--json") asJson = true;
  else if (a === "--with-t") withT = true;   // 追加教材命中
  else if (a === "--with-r") withR = true;   // 2026-11-11：追加辞典命中
  else if (a === "--with-mega") withMega = true;  // 2026-11-12：附 MEGA2 卷号线索
  // 2026-11-10：--gb 直接输出 GB/T 7714 标准引用串，省掉手工拼装
  else if (a === "--gb") gbMode = true;
  else if (a === "--chars") maxChars = parseInt(argv[++i], 10) || 160;
  else words.push(a);
}
if (words.length === 0) {
  console.log("用法: node quote.mjs [-n 5] [--book 文集05] [--exact] [--json] <关键词...>");
  process.exit(1);
}

// 卷次 → 书名的显示映射（只为输出好看，不改任何数据）
const BOOK_LABEL = [
  [/^文集(\d{2})/, (m) => `《马克思恩格斯文集》第${Number(m[1])}卷`],
  [/^选集(\d{2})/, (m) => `《马克思恩格斯选集》第${Number(m[1])}卷`],
  [/^列宁全集(\d{2})/, (m) => `《列宁全集》第${Number(m[1])}卷`],
  [/^教材-/, () => `教材`],
];
function labelOf(fname) {
  for (const [re, fn] of BOOK_LABEL) {
    const m = re.exec(fname);
    if (m) return fn(m);
  }
  return basename(fname).replace(/\.txt$/, "");
}

function buildTerms(word) {
  const w = word.toLowerCase().trim();
  const terms = new Set([w]);
  terms.add(w.replace(/[\s_\-]+/g, ""));
  const cjk = w.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const run of cjk) {
    if (run.length <= 2) { terms.add(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) terms.add(run.slice(i, i + 2));
  }
  for (const t of w.split(/\s+/)) if (t) terms.add(t);
  return [...terms].filter(Boolean);
}

// 2026-11-10 篇目索引（用户「缺1」：搜到页码但不知是哪一篇）
//   _toc.json 由 build_toc.py 从各卷目录页抽出，{相对路径: [{name,start,end}]}
let TOC = {};
try {
  TOC = JSON.parse(readFileSync("G:/path/to/knowledge-base/学科资料/_toc.json", "utf8"));
} catch { TOC = {}; }
function relOf(absPath) {
  // 与 _toc.json 的 key 对齐：相对 学科资料/ 的 posix 路径。
  // 2026-11-10 修：先统一分隔符再取子串，避免 Windows 反斜杠导致 rel 为空。
  const s = String(absPath).replace(/\\/g, "/");
  const i = s.indexOf("学科资料/");
  return i >= 0 ? s.slice(i + "学科资料/".length) : "";
}

// 2026-11-10 版本标注（用户「缺3」：有些老论文引中文第1版全集页码，对不上）。
// 库里全是**第2版**，所以引用时必须把版本显出来，不能只写「全集第44卷」。
// 从文件头的「出处卷次：」行取；取不到就留空，不猜。
function verOf(absPath) {
  try {
    const head = readFileSync(absPath, "utf8").slice(0, 1200);
    const m = /出处卷次[：:]\s*(.+)/.exec(head);
    if (m) return m[1].trim().replace(/／/g, "/");
    const n = /著作名[：:]\s*(.+)/.exec(head);
    return n ? n[1].trim() : "";
  } catch { return ""; }
}

function pieceOf(relPath, page) {
  const toc = TOC[relPath];
  if (!toc || !toc.length) return null;
  const p = parseInt(page, 10);
  if (!p) return null;
  // 2026-11-10 修：先排除附属篇目（说明/序言/目录/索引）。
  // 事故：查「人的本质」命中《文集》第1卷 p3，被判成「第一卷说明」——
  // 因为「第一卷说明 p1-5」跨度 4，「《黑格尔法哲学批判》导言 p3-18」跨度 15，
  // 按「区间最窄优先」就选了说明。但说明是编者文字，不是马克思原文。
  const real = toc.filter((x) => !x.aux);
  const pool = real.length ? real : toc;
  const inside = pool.filter((x) => x.start <= p && p <= x.end);
  if (inside.length) {
    // 同一页落在多篇内时，取**最长**区间的（正文大篇优先于卷内小标题）
    return inside.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0].name;
  }
  const before = pool.filter((x) => x.start <= p);
  return before.length ? before.sort((a, b) => b.start - a.start)[0].name : null;
}

const termSets = words.map((w) => ({ raw: w, terms: buildTerms(w) }));
// 2026-11-11 修（假页码事故）：
//   pdf2txt_paged.py 实际写两种页标记：
//     【pN】[PDFpM]   —— 印刷页码可信
//     【p?|pdfM】     —— 印刷页码不可信
//   但有的卷只有裸 [PDFpM]（印刷页码缺失/被降级时整枚【】都不写）。
//   旧正则 ^【p…】 只认第一种：
//     · 【pN】[PDFpM] 里 [PDFpM] 落进正文 → 命中的行会挂上一页的 pN = **张冠李戴的假页码**
//     · 裸 [PDFpM] 完全不认 → 该页沿用上一页的 pN = **同样张冠李戴**
//   实测：《鲍德里亚-符号政治经济学批判》353 页里有 49 个裸标记，全部会错挂。
//   现在的处理：一行里所有页标记都吃掉；裸 [PDFpM] 记为「?/pdfM」，
//   也就是只报 PDF 页序、绝不给印刷页码（宁可待核，不许给假页码）。
const PAGE = /^(【p(?:\d+|\?)(?:\|pdf\d+)?】|\[PDFp\d+\])/;

/** 解析一行里的页标记。返回 {page} 或 null（不是页标记行）。 */
function parsePageTag(line) {
  if (!PAGE.test(line)) return null;
  const m = /^【p(\d+|\?)(?:\|pdf(\d+))?】/.exec(line);
  const bare = /^\[PDFp(\d+)\]/.exec(line);
  if (m) {
    // 印刷页码可信 → 用 pN；不可信/缺失 → 退成 PDF 页序
    if (m[1] === "?") {
      const pdf = m[2] || (bare ? bare[1] : null);
      return { page: pdf ? `?/pdf${pdf}` : null };
    }
    return { page: m[1] };
  }
  if (bare) return { page: `?/pdf${bare[1]}` };
  return null;
}

function* walk(dir, depth = 0) {
  if (depth > 4) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      // 跳过中间产物目录
      if (/^_|待处理|\.bak/.test(e.name)) continue;
      yield* walk(join(dir, e.name), depth + 1);
      continue;
    }
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".txt")) continue;
    yield join(dir, e.name);
  }
}

const results = [];

for (const { dir, kind } of DIRS) {
  for (const file of walk(dir)) {
    const fname = basename(file);
    if (bookFilter && !fname.includes(bookFilter)) continue;
    let stat;
    try { stat = statSync(file); } catch { continue; }
    // 2026-11-10 修：原来硬跳过 >8MB 的文件。
    // 事故：MEGA 摘录卷 12.6MB，含 84 处「Economist」，但被这行跳过，
    // 查「Economist」时它根本没进候选——用户会以为库里没有。
    // 现在放宽到 64MB（单文件内存占用约 2 倍，64MB 尚可），
    // 并在命中时标注「大文件，只扫了前 N 行」以免误导。
    const BIG = 64 * 1024 * 1024;
    if (stat.size > BIG) continue;
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }

    // 2026-11-10 修：跳过文件头说明块。
    // 事故：MEGA书信文件头里写着「⚠ 本卷含大量他人写给马克思的信（Borkheim…）」，
    // 查「Borkheim」时这行**提示语**命中 100 处排第一，真正的书信在下面。
    // 判据：文件开头若以 ==== 起、又以 ==== 止，中间整块视为元数据，不参与检索。
    let _body = text;
    {
      const sepRe = /^={20,}\s*$/m;
      const first = sepRe.exec(text);
      if (first && first.index < 2000) {
        const rest = text.slice(first.index + first[0].length);
        const second = sepRe.exec(rest);
        if (second) _body = rest.slice(second.index + second[0].length);
      }
    }
    const lines = _body.split(/\r?\n/);
    let curPage = null;
    const hits = [];
    // 整串匹配用的「拼合串」：本行 + 下一行，解决 OCR 把一句话断在两行的问题。
    // 目标串本身不含标点时空格也去掉，免得「异化 劳动」匹配不上。
    const compact = (s) => s.replace(/[\s\u3000]+/g, "");
    const needles = termSets.map((ws) => compact(ws.raw));

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 2026-11-11：页标记改由 parsePageTag 统一解析（见函数注释里的假页码事故）。
      const pm = parsePageTag(line);
      if (pm) {
        curPage = pm.page;
        continue;
      }
      const t = line.trim();
      if (!t) continue;

      // 2026-11-10 修（用户实测曝出的 bug）：
      //   《〈政治经济学批判〉序言》最著名的那句「无论哪一个社会形态，在它所能容纳的全部生产力
      //   发挥出来以前，是决不会灭亡的」，在 203 MB 原文库里搜不到。
      //   原因不是原文缺失（PDF 第 797 页有），是 **OCR 排版把长句切成 3 行**，
      //   而这里只拼「本行+下一行」两行 —— 跨 3 行的句子永远拼不上。
      //   改为滑动窗口拼 WINDOW 行（默认 4），覆盖绝大多数排版断行。
      const WINDOW = 4;
      let tail = "";
      for (let k = i; k < Math.min(i + WINDOW, lines.length); k++) {
        const s = lines[k].trim();
        if (k === i) { tail = s; continue; }
        if (!s) break;                       // 空行 = 段落结束，不再跨
        if (PAGE.test(s)) break;             // 遇到页标记，不跨页拼
        tail += s;
      }
      const joined = compact(tail);
      const nextRaw = i + 1 < lines.length ? lines[i + 1].trim() : "";   // 显示用：下一行原文
      const self = compact(t);

      let hitTerms = 0;
      let occ = 0;
      let selfHit = 0;      // 本行自身就含整串（最可信）
      let crossHit = 0;    // 靠与下一行拼合才含整串（OCR 断行，可引但要核）
      for (const nd of needles) {
        if (!nd) continue;
        if (self.includes(nd)) { hitTerms++; occ++; selfHit++; continue; }
        if (joined.includes(nd)) { hitTerms++; occ++; crossHit++; continue; }
        if (loose) {
          const ws = termSets[needles.indexOf(nd)];
          if (ws.terms.some((term) => self.includes(compact(term)))) { hitTerms++; occ++; }
        }
      }
      if (hitTerms === 0) continue;

      hits.push({ line: i + 1, page: curPage, text: t, next: nextRaw, hitTerms, occ, selfHit, crossHit });
    }
    if (hits.length === 0) continue;

    // 排序（判据顺序，别乱）：
    //   0. **文件名整串等于查询**的最高优先（2026-11-09 补）。
    //      查「为人民服务」，就该先给《为人民服务》那一篇，而不是给引用了 91 次
    //      「为人民服务」这四个字的彭真文选。这是「篇名匹配」这一维，
    //      跟词频无关——词频说「谁提得多」，篇名说「这就是讲这个的那一篇」。
    //   1. 命中行是不是「一句话」——带句号/分号的排在只有词组的前面。
    //   2. 本行整串命中 > 靠拼下一行才命中
    //   3. 命中词数、带页码、密度
    const q = termSets.map(t => t.raw.replace(/\s+/g, "")).join("");
    const nameKey = fname.replace(/\.txt$/, "").replace(/^[^-]+-/, "").replace(/\s+/g, "");
    // 通用词黑名单：这些词命中标题不代表「这篇就是讲它的」
    const GENERIC = /^(社会主义|资本主义|马克思主义|唯物主义|唯心主义|辩证法|经济|政治|哲学|历史|国家|革命|劳动|实践|认识|社会|人民|群众|民主|自由|平等|意识形态|生产力|生产关系)$/;
    const nameMatch = (q.length >= 3 && !GENERIC.test(q) && nameKey.includes(q)) ? 1 : 0;

    const isSentence = (t) => /[。；]/.test(t) && t.length >= 12 ? 1 : 0;
    hits.sort((a, b) => {
      if (b.nameMatch !== a.nameMatch) return b.nameMatch - a.nameMatch;
      const sa = isSentence(a.text), sb = isSentence(b.text);
      if (sa !== sb) return sb - sa;
      if (b.selfHit !== a.selfHit) return b.selfHit - a.selfHit;
      if (b.hitTerms !== a.hitTerms) return b.hitTerms - a.hitTerms;
      const pa = a.page && !a.page.startsWith("?") ? 1 : 0;
      const pb = b.page && !b.page.startsWith("?") ? 1 : 0;
      if (pb !== pa) return pb - pa;
      return b.occ - a.occ;
    });
    hits.forEach((h) => { h.nameMatch = nameMatch; });

    results.push({
      kind,
      file: fname,
      label: labelOf(fname),
      // 2026-11-10 篇目：把每条命中的页码反查成「哪一篇」
      // 用户实测：「搜『异化劳动』返回整本《选集01》的 97 行，而不是《1844年手稿》这一篇」
      rel: relOf(file),
      ver: verOf(file),   // 版本（出处卷次行），用于区分全集1版/2版、《文集》/《选集》
      // 2026-11-10 修：原来 totalHits = hits.length = **含任意关键词的行数**，
      // 不是「整串命中次数」。于是「命中 11290 处」这种数字满天飞——
      // 实际是 11290 行里出现了「生产力/容纳」这类词，跟要找的那句话毫无关系。
      // 现在分开统计：exactHits = 真正的整串（含跨行拼合）命中数。
      totalHits: hits.length,
      exactHits: hits.reduce((n, h) => n + (h.selfHit || h.crossHit || 0), 0),
      nameMatch,
      hits: hits.slice(0, 3).map((h) => ({ ...h, piece: pieceOf(relOf(file), h.page) })),
    });
  }
}

// 原著排在教材前面；同档内按命中质量
// 按层号排（L0 在前），教材 T 排最后。同层内按命中质量。
const layerRank = (k) => {
  const m = /^L(\d)/.exec(k);
  if (m) return parseInt(m[1], 10);
  // 2026-11-09 新增两层（用户指定要补的辞书与党史）：
  //   R 辞书与工具书 —— 查词条定义、人物条目、会议条目用；不是「原文」，排在 L5 之后
  //   X 党史与专题   —— 党史叙述类；同属二手，排在 R 之后
  if (/^R/.test(k)) return 60;
  if (/^X/.test(k)) return 70;
  if (/^T/.test(k)) return 80;      // 教材永远在最后（原 50，给 R/X 让位）
  if (/^P/.test(k)) return 90;      // 2026-11-11：论文层，排在教材之后
  return 99;};
results.sort((a, b) => {
  // ── ⓿-0（2026-11-10 新增，优先级最高）：**原文层绝不能输给工具书/党史/教材**。
  //   事故：查「新民主主义」，第 2 条是《马克思主义大辞典》（命中 621 处），
  //   把张闻天选集（190 处）压下去。大辞典只是词条解释，不是谁的原话。
  //   判据：把层级分成三档，**低档永远排在高档前面，命中数不参与比较**。
  //     ① 原文档：L0–L5（马克思、毛泽东、阿尔都塞等本人著作）
  //     ② 二手档：R（辞典）、X（党史专题）
  //     ③ 教材档：T
  //   只有在同一档里，才让命中数说话。
  const tier = (k) => {
    if (/^L\d/.test(k)) return 0;
    if (/^[RX]/.test(k)) return 1;
    if (/^T/.test(k)) return 2;
    if (/^P/.test(k)) return 3;     // 2026-11-11：论文层，最低档
    return 3;
  };
  const tierA = tier(a.kind || ""), tierB = tier(b.kind || "");
  if (tierA !== tierB) return tierA - tierB;

  // ⓿ **整串命中数优先**（2026-11-10 定案，这一条排在最前）。
  //   理由：用户找的是「那句话在哪儿」。整串出现在哪些文件，哪些文件才是答案。
  //   原来这条排在很后面，靠「行命中数」，于是：
  //     查《〈政治经济学批判〉序言》名句 → 命中数 11290 的 MEGA 摘录排第一（其实一句都没有），
  //     真正有这句的《文集》第2卷 p592 被压到看不见。
  //   L0 加权 ×2：原文层比二手更该排前（但只在整串命中数相同时起作用，
  //   不会让「提了一句」的 L0 压过「真讲这个」的文献）。
  //   2026-11-10 定案（第三版）：**L0 硬优先**。
  //   实测数据：查《〈政治经济学批判〉序言》名句，
  //     激流导读命中 8 次（二手反复引用）、文集02 命中 3 次（原文只出现一次）。
  //   这是内容本身的性质——导读就是围着这句话写的。**命中数永远排不赢。**
  //   所以：L0 只要命中 ≥1 次，就排在所有非 L0 之前。
  //   这不是「原文更好」，是「用户要的是原文，二手是绕路」。
  {
    // 2026-11-10 修：kind 是 "L0 马恩列原著" 这种带中文的长串，不是 "L0"。
    // 第一版写 r.kind === "L0" 恒为假，整个优先级没生效。
    //
    // 二修（同日，用户实测副作用）：改成「无条件 L0 优先」后，查「此在」
    // 《资本论》里 63 处（「此在」是普通文言组合）把海德格尔《存在与时间》
    // 的 2949 处压到看不见——而「此在」根本不关马克思的事。
    // 现在加门槛：L0 命中数需 ≥「所有非 L0 最高命中数的一半」才享有优先。
    //   · 序言名句：L0 有 3–6 处，非 L0 最高 8 处，6 ≥ 4 → L0 优先（正确）
    //   · 此在：L0 63，非 L0 最高 2949，63 < 1474 → 让命中数说话（正确）
    const isL0 = (r) => /^L0\b/.test(r.kind || "");
    const maxOther = Math.max(0, ...results.filter((r) => !isL0(r)).map((r) => r.exactHits || 0));
    const gate = maxOther / 2;
    const za = (isL0(a) && (a.exactHits || 0) >= gate && (a.exactHits || 0) > 0) ? 0 : 1;
    const zb = (isL0(b) && (b.exactHits || 0) >= gate && (b.exactHits || 0) > 0) ? 0 : 1;
    if (za !== zb) return za - zb;
  }
  // ① 篇名整串匹配（已排除通用词）——《为人民服务》该排第一
  if (b.nameMatch !== a.nameMatch) return b.nameMatch - a.nameMatch;
  // ①.5 原文压过教材（2026-11-09 实测）：
  //   查「绿水青山就是金山银山」，教材引用 6 次、习近平原文 2 次，
  //   按命中数排教材就压上来了。但教材是「别人怎么讲」，原文是「本人怎么讲」——
  //   引这句话要拿原话，不是拿教科书转述。所以原文层永远在教材前。
  const ta = /^T\b/.test(a.kind || "") ? 1 : 0, tb = /^T\b/.test(b.kind || "") ? 1 : 0;
  if (tierA !== tierB) return tierA - tierB;
  // ①.6 参考性文件降权（2026-11-10 实测）：
  //   查「Borkheim」，MEGA 年鉴的**目录页**命中 138 处，压过真正的 246 封书信（98 处）。
  //   原因：年鉴目录里有大量人名索引，命中数天然高，但那是"提到谁"，不是"谁写的"。
  //   判据：文件名含 inhalt/einfuehrung/einf/register/prospekt/korrigenda/index 的，
  //        一律视为参考性文件，排在实物材料之后。
  const REF = /inhalt|einfuehrung|einf|register|prospekt|korrigenda|_index|repertorium/i;
  const ra = REF.test(a.file || a.fname || "") ? 1 : 0;
  const rb = REF.test(b.file || b.fname || "") ? 1 : 0;
  if (ra !== rb) return ra - rb;

  // ①.7 二手「导读/评介/研究」降权（2026-11-10 用户实测曝出）：
  //   查《〈政治经济学批判〉序言》名句，前 4 条全是「激流-《政治经济学批判序言、导言》导读」，
  //   L0 原文一条都没有。原因：二手文里那句话是**完整一句**，容易整串命中；
  //   L0 是 OCR 断行的碎片，靠拼合才命中，命中数反而低。
  //   判据：文件名含 导读/评介/研究/解析/浅析/述评/教程/讲义 的，视为二手，排在原文之后。
  //
  // 2026-11-11 修：**把「概论」从名单里去掉**。
  //   事故：查「日常生活批判」，衣俊卿《西方马克思主义概论》命中 46 处，
  //   却排在只命中 4 处的弗兰尼茨基后面 —— 因为它名叫「概论」，被当成了二手导读。
  //   查 11 个衣俊卿核心概念，这本一次都没进首条。
  //   「概论」是学术专著常用书名（徐禾《政治经济学概论》同理），**不等于二手**。
  //   真正该降的是「导读/浅析/述评」这类，它们的功能就是转述别人的话。
  const SECOND = /导读|评介|解析|浅析|述评|教程|讲义|通释|疏证|读本/;
  const sa = SECOND.test(a.file || a.fname || "") ? 1 : 0;
  const sb = SECOND.test(b.file || b.fname || "") ? 1 : 0;
  if (sa !== sb) return sa - sb;

  // ①.8 原文层（L0/L1/L2/L3/L4/L5 有页码的一手文献）优先于无页码的网页源。
  //   2026-11-10：这条以前只在「层序」里体现，但层序排在命中数之后，
  //   命中数一差就翻不过来。这里提到命中数之前。

  // ② 命中词数：一句话里命中几个查询词
  const qa = a.hits[0].hitTerms, qb = b.hits[0].hitTerms;
  if (qb !== qa) return qb - qa;
  // ③ 命中总数：这本书到底讲了多少处。
  //    2026-11-09 踩出来的：查 "division of labour"，斯密 22 处 vs 斯宾诺莎 1 处，
  //    但斯宾诺莎在 L3、斯密在 L5，层序把 1 处排到了 22 处前面——荒谬。
  //    命中数是「用户想找哪一句」的直接信号，层序只是先验，所以命中数在前。
  if (b.exactHits !== a.exactHits) return b.exactHits - a.exactHits;
  // ④ 层序：同等命中量下，L0 优先
  const la = layerRank(a.kind), lb = layerRank(b.kind);
  return la - lb;
});

// ── 2026-11-10 新增：TOC 标题索引 ──
//   事故：查「异化劳动和私有财产」，第一条永远是「本卷收录了…的部分」这种
//   提到该词的叙述句，真正的标题句排不进去。
//   而 _toc.json 里其实存着全部标题（47 个文件、上千条），只是从没被当索引用。
//   这里在正文检索之外，单独搜一遍 TOC：命中标题的，插到最前面。
function tocTitleHits(q) {
  const out = [];
  const needle = q.trim();
  // 2026-11-10 六修：**短词不启用标题索引**。
  //   事故：查「异化劳动」（4 字），标题「异化劳动和私有财产」（10 字）占比 40% 也通过，
  //   把正文命中全挤下去——用户查的是这个概念，不是这一节。
  //   判据：查询词 ≥ 5 字才启用；短概念词（异化劳动/生产力/剩余价值）走正文命中。
  if (needle.length < 3) return out;
  if (needle.length < 5) return out;
  for (const [rel, toc] of Object.entries(TOC)) {
    if (!Array.isArray(toc)) continue;
    for (const x of toc) {
      const name = String(x.name || "");
      // 2026-11-10 二修：**必须是「高度吻合」，不是「包含」**。
      //   事故：查「异化劳动」，第一条变成「[异化劳动和私有财产)」章节标题——
      //   标题里含这个词就插到最前，把正文命中全挤下去了。
      //   判据：查询词占标题的比例 ≥ 60%，或者标题去掉编号后与查询词相差 ≤ 4 字。
      const bare = name.replace(/^\s*[0-9０-９一二三四五六七八九十]+[.．、]\s*/, "")
                        .replace(/^\s*第[一二三四五六七八九十]+[篇章节]\s*/, "")
                        .replace(/[\[\]【】〔〕《》*　 \s]/g, "");
      const hitName = bare.includes(needle);
      if (!hitName) continue;
      // 2026-11-10 三修：**不再用「近似」判据**。
      //   事故：TOC 里有一条被截断的标题「[异化劳动和私有」（少「财产」两字），
      //   于是 bare.length - needle.length = 2，被判成「近似」，
      //   查「异化劳动」时它因为更短反而抢到第一。
      //   现在只认「完整包含」+「查询词占比 ≥ 60%」。
      // 2026-11-10 四修：占比阈值从 60% 降到 30%。
      //   事故：TOC 标题「2. 体现在商品中的劳动的二重性」去掉编号后 19 字，
      //   查询词「劳动的二重性」6 字，占比 32% < 60%，被过滤 → 退回叙述句 p59。
      //   30% 能放过「X的Y」这类标题，同时仍挡住「异化劳动」→「异化劳动和私有财产」这种。
      if (!bare.includes(needle)) continue;
      const cover = needle.length / Math.max(bare.length, 1);
      if (cover < 0.3) continue;
      // 2026-11-10 五修：**分清「标题命中」和「标题顺带包含」**。
      //   事故：查「异化劳动」时，标题「异化劳动和私有财产」占比 5/10=50% 也通过，
      //   于是把「异化劳动」的正文命中全挤下去。
      //   判据：占比 ≥ 80% 算「这就是标题」（如「货币转化为资本」→「第四章货币转化为资本」），
      //        否则只当「补充条目」，不插最前。
      x._primary = cover >= 0.8;
      if (x.aux) continue;                      // 说明/序言/索引不参与
      // 从相对路径认出层
      const lm = /(^|\/)(L\d|T|R|X)-/.exec(rel);
      const kind = lm ? LAYERS.find((l) => l.prefix === lm[2] + "-")?.kind || "" : "";
      out.push({
        file: rel,
        label: (name.replace(/[\.．·…\s]+\d*\s*$/, "").trim() || name).slice(0, 60),
        // 2026-11-11 加：**记住真实书名**。
        //   事故：查「对立统一规律」，第一条显示成
        //       📖 第一章对立统一规律　（李达-唯物辩证法大纲.txt · 命中 1 处）
        //   用户会以为书名是「第一章对立统一规律」，真实书名藏在括号里。
        //   现在把书名列出来，渲染时用 bookLabel 而不是 label。
        bookLabel: (() => {
          const fn = rel.split("/").pop().replace(/\.txt$/, "");
          return fn;
        })(),
        kind,
        ver: "",
        exactHits: 1,
        hits: [{ page: String(x.start), text: "〔章节标题〕" + name, exact: true }],
        totalHits: 1,
        hitCount: 1,
        lineCount: 1,
        titleHit: true,
      });
    }
  }
  return out.slice(0, 3);
}

// 2026-11-10：--with-t 时，额外从 T 层（教材）挑前 2 条附在末尾。
//   教材永远不抢原著的位置，但也不能真的「看不见」。
let megaNote = "";   // 2026-11-12：--with-mega 的参照提示，末尾单独一行
let shown = results.slice(0, limit);
// 2026-11-10：TOC 标题命中插到最前（同一词若也是正文命中，标题优先）
{
  const th = tocTitleHits(words.join(" "));
  if (th.length) {
    const seen = new Set(th.map((x) => x.label + x.hits[0].page));
    shown = th.concat(shown.filter((x) => !seen.has(x.label + (x.hits?.[0]?.page || ""))));
  }
}
if (withT) {
  const tHits = results.filter((r) => /^T/.test(r.kind || "") && !shown.includes(r)).slice(0, 2);
  if (tHits.length) shown = shown.concat(tHits);
}
// 2026-11-11 新增：--with-r 额外附上辞典（R 层）命中。
//   为什么需要：R 层排在最后，查高频词（唯物史观 / 生产力 / 意识形态）
//   命中 100+ 份时，辞典永远挤不进展示列表。
//   实测：「唯物史观」命中 109 份，展示 60 条，四本辞典一条都看不见；
//        而「延安整风」命中 32 份，四本辞典全都在。
//   高频词恰恰最需要辞典的定义。所以给一个显式开关，把辞典挑出来附在末尾。
if (withR) {
  const rHits = results.filter((r) => /^R/.test(r.kind || "") && !shown.includes(r)).slice(0, 3);
  if (rHits.length) shown = shown.concat(rHits);
}
// 2026-11-12 新增：--with-mega 附 MEGA2 参照线索。
//
//   为什么要单独一个开关、而且**只报卷号不贴原文**：
//     ① MEGA2 是德文，库里 3,123 万字。查中文词时它偶尔能命中（译名、
//        人名、术语的德文原文），但把德文段落贴出来对中文检索没帮助。
//     ② 它的用途是**参照**——「马克思这句话在 MEGA2 哪一卷有原文/异文」，
//        不是「这句中文长什么样」。
//     ③ MEGA2 没有印刷页码（前置部分用罗马数字），贴出来也引不了。
//   所以：只报「哪几卷提到了」，一次最多 5 卷，末尾一行提示。
if (withMega) {
  const mHits = results.filter((r) => /MEGA/.test(r.file || ""));
  if (mHits.length) {
    const vols = new Map();     // 卷 → 命中数
    for (const r of mHits) {
      // 从文件名提卷号：mega_II-14_inhalt-einf → II/14
      const fn = (r.file || "").split("/").pop() || "";
      let v = null;
      if (/^MEJB|^mejb/i.test(fn)) v = "年鉴";
      else if (/^MEGA书信|^MEGA摘录/.test(fn)) v = fn.replace(/\.txt$/, "").slice(0, 12);
      else {
        const m = fn.match(/(?:mega|MEGA)[_ -]*(I{1,3}V?|IV)[-_ ]?(\d+)/i);
        if (m) v = `${m[1].toUpperCase()}/${m[2]}`;
      }
      if (!v) continue;
      vols.set(v, (vols.get(v) || 0) + (r.exactHits || r.totalHits || 0));
    }
    const top = [...vols.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length) {
      megaNote = `📦 MEGA² 参照（德文，无印刷页码，只作对照）：` +
        top.map(([v, n]) => `${v}（${n} 处）`).join("　");
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ query: words.join(" "), count: results.length, shown }, null, 1));
  process.exit(0);
}

if (shown.length === 0) {
  console.log(`原文库里没找到「${words.join(" ")}」。`);
  // 2026-11-10：不是所有查不到的词都是「库里没有」。
  // 有些是**后人概括的提法**，原著里没有这个说法，只有它的表述。
  // 实测：「两个必然」→ 原文是「资产阶级的灭亡和无产阶级的胜利是同样不可避免的」；
  //       「两个决不会」→ 原文是「决不会灭亡」「决不会出现」。
  const ALIAS = [
    [/两个必然|两个必然性/, "资产阶级的灭亡和无产阶级的胜利是同样不可避免的"],
    [/两个决不会|两个绝不会/, "决不会灭亡"],
    [/三来源三组成|三个来源/, "马克思主义的三个来源和三个组成部分"],
    [/劳动二重性/, "具体劳动和抽象劳动"],
    [/异化劳动/, "异化劳动和私有财产"],
    // 2026-11-10 补（用户实测「从抽象到具体」查不到 L0）：
    //   这是后人的概括。马克思原话是「抽象上升到具体」（《导言》，文集02 等 26 处）。
    [/从抽象到具体|从抽象到具体的/, "抽象上升到具体"],
    // 「实践」太通用（萨特 2171 处压过一切）。要查马克思的实践观，用这句：
    [/^实践$/, "哲学家们只是用不同的方式解释世界"],
  ];
  const q0 = words.join("");
  const hit = ALIAS.find(([re]) => re.test(q0));
  if (hit) {
    console.log(`→ 这是**后人的概括**，原著里没有这个说法。试原文表述：「${hit[1]}」`);
    console.log(`   node quote.mjs --exact "${hit[1]}"`);
  }
  console.log("→ 不要凭记忆补句子。写【待核对】，或换关键词、或用 kb.mjs 找二手线索再回头核原文。");
  process.exit(0);
}

console.log(`原文命中 ${results.length} 份文件，显示前 ${shown.length}（关键词：${words.join(" ")}）\n`);

// 2026-11-10：命中结果里若**前 3 条没有 L0 原文**，提示改用原话表述。
// 事故：「从抽象到具体」命中的是阿尔都塞/张闻天/费尔巴哈，没有马克思——
//       因为马克思原话是「抽象上升到具体」。「实践」被萨特 2171 处压住。
{
  const topL0 = shown.slice(0, 3).some((r) => /^L0/.test(r.kind || ""));
  if (!topL0) {
    const q0 = words.join("");
    const HINT = [
      [/从抽象到具体/, "抽象上升到具体"],
      [/^实践$/, "哲学家们只是用不同的方式解释世界"],
      [/劳动二重性/, "具体劳动和抽象劳动"],
    ];
    const h = HINT.find(([re]) => re.test(q0));
    if (h) {
      console.log(`⚠ 前 3 条无 L0 原文。马克思的原话是「${h[1]}」，试：`);
      console.log(`   node quote.mjs --exact "${h[1]}"\n`);
    }
  }
}

// 2026-11-10 新增 --gb：直接输出 GB/T 7714 风格引用串。
//   目标形态：马克思：《1844年经济学哲学手稿》，《马克思恩格斯文集》第1卷，人民出版社2009年版，第162页。
//   材料从三处拼：篇名（h.piece）+ 书名卷次（r.label）+ 出版项（r.ver）+ 页码（h.page）。
//   拼不全就明说缺哪一段，不硬凑。
function gbCite(r, h) {
  // 2026-11-10：篇名要做三步清理，否则会把目录里的点线残留带进引用。
  // 实测脏样本：「卡·马克思关于费尔巴哈的提纲… ..1」「[异化劳动和私有」「4.商品的拜物教性质及其秘密」
  let piece = (h.piece || "")
    .replace(/^[*＊\s]+/, "")                       // 前导星号（编者标记）
    .replace(/[.．·…\s]+\d*\s*$/, "")               // 尾部点线 + 页码残留
    .replace(/[（(]节选[)）]$/, "")                  // 「（节选）」
    .replace(/[\[\]［］]/g, "")                      // 方括号（本书用方括号标编者拟题）
    .trim();
  // 篇名前若挂着作者（「卡·马克思 …」），拆出来单独放前面，符合 GB 格式
  // 2026-11-10 二修：目录里合成篇名形如「卡·马克思和弗·恩格斯共产党宣言」，
  // 第一版只拆第一个作者，剩下「和弗·恩格斯共产党宣言」被当篇名。
  // 现在把「和/、弗·恩格斯」这类第二作者也剥掉。
  // 用数组匹配而非嵌套 RegExp 字符串，避免 \\s 双重转义出错。
  const AUTHS = ["卡·马克思", "弗·恩格斯", "列宁", "斯大林", "毛泽东",
                 "邓小平", "江泽民", "胡锦涛", "习近平"];
  let author = "";
  let rest = piece;
  const found = [];
  for (const a of AUTHS) {
    const idx = rest.indexOf(a);
    if (idx === 0 || (idx > 0 && /[和、]/.test(rest[idx - 1]))) {
      found.push(a);
      rest = rest.replace(a, "");
    }
  }
  if (found.length) {
    author = [...new Set(found)].join("、");
    rest = rest.replace(/^[和、\s]+/, "").replace(/[和、\s]+$/, "").trim();
    if (rest) piece = rest;
  }
  // 2026-11-10：无页码页不给假页码，引用串里直接留空，让他自己翻原书填
  const page = h.page && !String(h.page).startsWith("?") ? `第${h.page}页` : "第〔　〕页（原书无印页码）";
  let pub = "";
  const m = /\/\s*([^/]+?)\s*(\d{4})年/.exec(r.ver || "");
  if (m) pub = `${m[1].trim()}${m[2]}年版`;
  const parts = [];
  if (author) parts.push(`${author}：`);
  if (piece) parts.push(`${piece}，`);
  parts.push(r.label);
  if (pub) parts.push(`，${pub}`);
  // 2026-11-10：MEGA 这类没有「XX出版社XX年版」的，出版项直接写卷号。
  // 注意 MEGA¹ 与 MEGA² 必须分清——1932 年的梁赞诺夫版和 1975 年之后的历史考证版
  // 是两套不同的书，页码完全不通用，混写会让引用彻底失效。
  else if (/^MEGA/.test(r.ver || "")) {
    const v = (r.ver || "").replace(/^MEGA[²¹]?\s*/, "").trim();
    const isMega1 = /MEGA¹|MEGA1/i.test(r.ver || "") ||
                    /MEGA1|1932|Adoratskij|Rjazanov/i.test(r.file || "");
    parts.push(`，${isMega1 ? "MEGA¹" : "MEGA²"} ${v}`);
  }
  parts.push(`，${page}。`);
  return parts.join("");
}

for (const r of shown) {
  const tag = r.kind.startsWith("L0") || r.kind.startsWith("L1") ? "📖" : "📚";
  // 2026-11-11：目录标题命中时，书名在前、章节名在后。
  //   原来显示成「📖 第一章对立统一规律（李达-唯物辩证法大纲.txt · 命中 1 处）」，
  //   让人以为书名是「第一章对立统一规律」。
  if (r.titleHit && r.bookLabel) {
    console.log(`${tag} ${r.bookLabel}　〔章节〕${r.label}`);
  } else {
    console.log(`${tag} ${r.label}　（${r.file} · 命中 ${r.totalHits} 处）`);
  }
  // 2026-11-10：版本行。全集有第 1 版/第 2 版之分，页码不通用，必须显出来。
  if (r.ver) console.log(`   〔版本〕${r.ver}`);
  for (const h of r.hits) {
    const pageTxt = h.page === null
      ? "〈无页码标记〉"
      // 2026-11-10 十二修（用户「宁无不假」）：无页码页不再写「页码待核」，
      //   只报 PDF 页序号，让人自己去翻。假页码比没页码危险。
      // 2026-11-11 修渲染：内部存的是「?/pdf30」，旧代码 slice(1) 得到「/pdf30」，
      //   拼成「PDF第/pdf30页」。改为剥掉「?/pdf」前缀只留数字。
      : (h.page.startsWith("?/pdf")
        ? `[PDF第${h.page.slice(5)}页·无印页码]`
        : h.page.startsWith("?") ? "[无印页码]" : `p${h.page}`);
    let body = h.text;
    if (body.length > maxChars) body = body.slice(0, maxChars) + "…";
    // 断行命中：原句跨两行，把下一行接出来，让他看到完整一句
    if (!h.selfHit && h.crossHit && h.next) {
      body = `${body}⏎${h.next.length > 80 ? h.next.slice(0, 80) + "…" : h.next}`;
    }
    // 2026-11-10：显示所属篇目（从卷内目录反查，可能因跨篇重叠有小误差）
    if (h.piece) {
      body = `〔篇〕${h.piece}｜${body}`;
    }
    console.log(`   ${pageTxt}　「${body}」`);
    if (gbMode) console.log(`   〔引用〕${gbCite(r, h)}`);
  }
  console.log("");
}

if (megaNote) console.log(megaNote);
console.log("引用规则：pN 可直接写成「（《…》第X卷，第N页）」；标「无印刷页码」的，页码位留空，自己翻原书填。宁可不填，不许编号。");
