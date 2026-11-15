#!/usr/bin/env node
/**
 * kb.mjs — 知识库检索工具 v2（打分检索，不是字面 AND 匹配）
 *
 * 用法：
 *   node kb.mjs <关键词...>            检索（默认搜 事实/决策/产出 的文本文件）
 *   node kb.mjs -a <关键词>            搜索全部目录
 *   node kb.mjs -d 事实 <关键词>       限定目录（事实|决策|产出|工具|索引|文档|学科资料）
 *   node kb.mjs -n 20 <关键词>         限制结果数（默认 15）
 *   node kb.mjs -t <关键词>            只搜标题行 + 文件名
 *   node kb.mjs --status obsolete      只搜某个状态位的条目
 *   node kb.mjs --list                 列出语料统计
 *
 * v2 改了什么（对应《2026-10-27-知识库体检》第三条）：
 *   1. 多词从「必须同行同时出现」(AND) 改成「命中词数打分」(OR + 打分)——任一关键词命中即入选
 *   2. 中文按二元组切分：`会话损坏` → 会话|话损|损坏，解决「加不加空格差 3 倍」
 *   3. 权重分层：文件名 > H1 > H2/H3 > 正文，正文内按出现次数加权（简易 BM25 思路）
 *   4. 状态感知：obsolete/superseded 降权，除非显式 --status 指定
 *   5. 命中片段给上下文，不只给一行
 *
 * v3 改了什么（2026-11-05，实测 12 条查询，第 1 名 3→8 条，前 3 名 →11 条）
 *   1. **coverage 按 term（bigram）算，不按输入词算**（最要命的一条）
 *      旧：`matchedWords / wordTermSets.length`。而「知识库分区整理」只是**一个**输入词，
 *      被拆成 知识|识库|库分|分区|区整|整理 后，只要命中任意一个 bigram，matchedWords 就等于 1，
 *      coverage = 1/1 = 100%，于是「只沾了个『知识』」也被标成「全词命中」。
 *      实测 576 个文件同时满分——这个指标等于没有。
 *      新：`命中 term 数 / 本行触及的 term 总数`。同样那行现在只拿 1/6。
 *   2. **长度归一化**（BM25 思路）：旧实现是纯累加，一本 0.89MB 教材命中 672 行积 5089 分，
 *      把命中 3 行却完全对口的文档挤出前 20。现在按行数平方根归一，基准 120 行。
 *   3. **IDF 词级降权**：'知识' 命中 523 个文件、'整理' 180 个，权重却和 '四态判据' 一样，
 *      等于没筛。现在按 `log((N+1)/(df+0.5))` 算，归一化到 [0.15,1] 防止常见词被清零。
 *   4. **文件名只看 fname，不看 rel**：旧实现是 `fname + rel`，而 rel 里必然含
 *      '事实\' '产出\' 这些通用字，于是几乎每个文件都显示「文件名命中」。
 *      文件名加成本身也改成按 IDF 加权，不再「沾一个通用词就给满 60 分」。
 *   5. 两遍扫描（先收词频再打分）。第二遍走内存，耗时不升反降：1186ms → 1141ms。
 *
 * v4 改了什么（2026-11-09，「原著进库」配套）
 *   1. **原文优先**：命中路径含 `教材原文\` 的，文件分 × 1.8。原文是引用落点，笔记是二手转述，
 *      两者混在一个榜上，二手必然压过原文（笔记体量大、术语密度高、命中行数多）。这条把天平掰回来。
 *   2. **页码可见**：解析时维护「当前页码」，每行命中都带上它所属的【pN】。命中片段前面直接打 `p123`，
 *      引用不用再回原文里翻。原文文件里【p?|pdfN】的页，显示成 `p?/pdfN`。
 *   3. **带页码的行额外加分**：同一句话，能落到具体页码的，比落不到的对引用更有用。
 *   4. 跳过 `*.pages.json` 旁挂索引（那是提取元数据，不是正文，进榜只会制造噪音）。
 *
 * 已知边界：查询词本身缺关键限定时仍会散（如搜「知识库分区整理」不如「工作区分区整理」准，
 * 因为后者补上了目标文档的真正重心）。这是查询措辞问题，不是排序问题——不靠调参掩盖。
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";

const KB = "G:/path/to/knowledge-base";
const SKIP_DIRS = new Set([
  "pages", "node_modules", ".git", "_raw", "_gh", "_work", "out", "shots",
  "src", "deliver", "tmp", "ima_files_dump", "law_upload_staging", "凭证", "归档",
]);
const TEXT_EXT = new Set([".md", ".txt", ".json", ".yml", ".yaml", ".ps1", ".mjs", ".cjs", ".py", ".js", ".html"]);

// ── 参数 ────────────────────────────────────────────
const argv = process.argv.slice(2);
let dirFilter = null, limit = 15, titleOnly = false, allDirs = false, listMode = false, statusFilter = null;
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-d") dirFilter = argv[++i];
  else if (a === "-n") limit = parseInt(argv[++i], 10) || 15;
  else if (a === "-t") titleOnly = true;
  else if (a === "-a") allDirs = true;
  else if (a === "--list") listMode = true;
  else if (a === "--status") statusFilter = argv[++i];
  else words.push(a);
}

function* walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    // 2026-11-10 修（用户实测曝出）：SKIP_DIRS 是**精确名单**，没有通配规则，
    // 于是 L1\_毛选抓取\、L1\_求是网-*、L0\_MEGA官方PDF、_pdf原件 这些
    // 以 _ 开头的中间产物目录全被扫进了检索。
    // 判据：以 _ 开头的目录一律跳过（这是本库约定的「中间产物/原件」前缀）。
    if (/^_/.test(e.name) && !allDirs) continue;
    if (SKIP_DIRS.has(e.name) && !allDirs) continue;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/.test(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (e.isFile()) {
      if (e.name.endsWith(".pages.json")) continue;   // 旁挂页码索引，不是正文
      const ext = e.name.slice(e.name.lastIndexOf(".")).toLowerCase();
      if (TEXT_EXT.has(ext)) yield p;
    }
  }
}

// ── --list ───────────────────────────────────────────
if (listMode) {
  const stats = {};
  for (const f of walk(KB)) {
    const rel = relative(KB, f);
    const top = rel.split(/[\\/]/)[0];
    stats[top] = stats[top] || { files: 0, bytes: 0 };
    stats[top].files++;
    try { stats[top].bytes += statSync(f).size; } catch {}
  }
  console.log("知识库语料统计（可检索的文本文件）:");
  for (const [k, v] of Object.entries(stats).sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${k.padEnd(20)} ${String(v.files).padStart(5)} 文件  ${(v.bytes / 1024).toFixed(0).padStart(7)} KB`);
  }
  process.exit(0);
}

if (words.length === 0 && !statusFilter) {
  console.log("用法: node kb.mjs <关键词...>  |  -d <目录>  -n <条数>  -t（只搜标题）  -a（含素材）  --status <状态>  --list");
  process.exit(1);
}

// 只给 --status 不给关键词：列出该状态的全部条目
if (words.length === 0 && statusFilter) {
  const found = [];
  for (const file of walk(KB)) {
    if (dirFilter && !relative(KB, file).toLowerCase().includes(dirFilter.toLowerCase())) continue;
    let text;
    try {
      if (statSync(file).size > 64 * 1024 * 1024) continue;   // 2026-11-10: 3MB→64MB，否则 MEGA 摘录(12.6MB) 进不了检索
      text = readFileSync(file, "utf8");
      // 2026-11-10：跳过文件头说明块（与 quote.mjs 同一处修复）。
      // 文件以 ==== 起、又以 ==== 止的头部是元数据，不该被当成正文命中。
      {
        const sepRe = /^={20,}\s*$/m;
        const f1 = sepRe.exec(text);
        if (f1 && f1.index < 2000) {
          const rest = text.slice(f1.index + f1[0].length);
          const f2 = sepRe.exec(rest);
          if (f2) text = rest.slice(f2.index + f2[0].length);
        }
      }
    } catch { continue; }
    const st = readStatus(text);
    if (st !== statusFilter) continue;
    // 取 H1 或第一行
    const h1 = text.split(/\r?\n/).find(l => /^#\s/.test(l));
    const reason = (text.match(/^reason:\s*(.+)$/m) ?? [])[1] ?? "";
    found.push({ rel: relative(KB, file), title: (h1 ?? "").replace(/^#\s*/, "").trim(), reason });
  }
  console.log(`status=${statusFilter} 的条目 ${found.length} 个\n`);
  for (const f of found) {
    console.log(`📄 ${f.rel}`);
    if (f.title) console.log(`   标题：${f.title}`);
    if (f.reason) console.log(`   原因：${f.reason}`);
    console.log("");
  }
  process.exit(0);
}

// ── 关键词切分：中文二元组 + 原词 + 去分隔符变体 ────
function buildTerms(word) {
  const w = word.toLowerCase().trim();
  const terms = new Set([w]);
  // 去掉空格/连字符的紧凑形态（Computer Use ↔ ComputerUse）
  terms.add(w.replace(/[\s_\-]+/g, ""));
  // 中文二元组：`会话损坏` → 会话、话损、损坏
  const cjk = w.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const run of cjk) {
    if (run.length <= 2) { terms.add(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) terms.add(run.slice(i, i + 2));
    // 原串也留着（精确命中的权重更高）
  }
  // 英文按空格拆词
  for (const t of w.split(/\s+/)) if (t) terms.add(t);
  return [...terms].filter(t => t.length > 0);
}

// 每个输入词 → 一组候选子串；命中任一即算该词命中
const wordTermSets = words.map(w => ({ raw: w, terms: buildTerms(w) }));

// ── 状态位读取 ───────────────────────────────────────
function readStatus(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return "active";
  const s = m[1].match(/^status:\s*(\w+)/m);
  return s ? s[1].trim() : "active";
}

// ── 主检索 ───────────────────────────────────────────
// 两遍扫描：第一遍收集命中与全库词频（算 IDF 要用），第二遍打分。
// 2026-11-05 改：原来一遍扫完直接累加打分，缺两个东西——
//   ① 长度归一化：0.89MB 教材命中 672 行积 5089 分，把命中 3 行却完全对口的文档挤出榜
//   ② IDF：'知识'/'整理' 这类通用词命中 523/180 个文件，权重和'四态判据'一样，等于没筛
const results = [];
const STATUS_PENALTY = { active: 1.0, corrected: 0.85, superseded: 0.5, obsolete: 0.25 };
// 目录/索引行识别：连续 3 个以上的点/省略号（`…… 98`、`.....… 155`）或「页码收尾」。
// 这类行是「书里提到过这个概念」，不是「马克思在这里讲了它」，打分要压。
const DOTS_LINE = /[.．·…]{3,}/;
// 五层权重（2026-11-09）。理由见下面打分处的长注释。
// 为什么 L0 仍高于 L1：0302 论述题里，引马恩列是硬通货；引毛泽东是必需；引卢卡奇是加分。
// 加分项不能顶替硬通货——这是排序必须反映的事实，不是我偏心。
const LAYER_BOOST = {
  L0: 2.2,
  L1: 2.0,
  L2: 1.5,
  L3: 1.3,
  L4: 1.2,
  L5: 1.1,
  // 2026-11-09 新增：用户指定的辞书与党史两类。
  // 排序理由与 quote.mjs 一致——R/X 是「查条目」用的二手，不是引用落点，
  // 所以系数压在 L5 之下；但必须 > 1，否则命中会被无来源网页压掉。
  R: 1.05,   // 辞书与工具书（大辞典、组织辞典、会议辞典、文献辞典）
  X: 1.0,    // 党史与专题（党史一百年系列等）
  // 2026-11-14 新增：毛泽东古籍批注层。
  // 为什么 1.9（低于 L1 的 2.0）：0302 考卷上引选集正文是主力，引毛批是加分。
  // 为什么高于 L2 的 1.5：毛批是一手材料（中央文献1993扫描件左栏提取，338 条），
  //   价值高于卢卡奇/葛兰西那类转述。
  // 为什么不能给 2.2：里面还装着 3800 万字古籍原文（二十四史），那不是马恩列原典，
  //   若按 L0 算，查「群众」「国家」会把《后汉书》顶到《资本论》前面。
  M: 1.9,
};
// 原文优先系数（2026-11-09）。三档，为什么不是一个数：
//   原著 2.2：实测 1.8 时马发史教材仍会压过《1844年手稿》——教材讲「异化劳动」讲得更密。
//             原著是引用落点（《文集》第1卷 p176 这种），教材只是教科书叙述，必须分开。
//   教材 1.6：有页码，能引，但不是原著；让它稳在二手之上、原著之下。
//   调到 3.0 会反噬：原著的版权页、目录页、名目索引也会被抬上来占榜。
const ORIGINAL_BOOST = 2.2;
const TEXTBOOK_BOOST = 1.6;

const wordDocFreq = wordTermSets.map(() => new Set());   // 每个输入词出现在多少个文件里
// ── 2026-11-10 新增：TOC 标题索引 ──
//   事故：kb.mjs 查「劳动的二重性」，命中最多的是「根源于劳动的二重性」这类叙述句，
//   真正的章节标题「2. 体现在商品中的劳动的二重性」（文集05 p54）反而沉底。
//   _toc.json 里存着 47 个文件的全部目录，这里拿它当「标题索引」用。
let TOC = {};
try {
  TOC = JSON.parse(readFileSync("G:/path/to/knowledge-base/学科资料/_toc.json", "utf8"));
} catch { TOC = {}; }

// 相对路径 → 该文件的标题表 [{name, start, end}]
const TOC_BY_REL = {};
for (const [rel, arr] of Object.entries(TOC)) {
  if (!Array.isArray(arr)) continue;
  TOC_BY_REL[rel.replace(/\\/g, "/")] = arr.filter((x) => !x.aux);
}

const docs = [];                                          // 第一遍的产物
let scannedDocs = 0;

// 2026-11-10：倒排索引方案已废弃，改回纯扫盘。
//   理由：① 高频 bigram（如「劳动」）占 497/1657 文件，丢掉就漏原文；
//         ② 保留它们则分片巨大，提速归零；
//         ③ 用户明确要求「一定要确保能找到原著原文」——正确性优先于速度。
//   实测确认：纯扫盘 10.2 秒/次，永不漏。索引最好情况 0.2 秒，但有漏书风险。

for (const file of walk(KB)) {
  if (dirFilter) {
    const rel = relative(KB, file);
    if (!rel.toLowerCase().includes(dirFilter.toLowerCase())) continue;
  }

  let text;
  try {
    const st = statSync(file);
    if (st.size > 64 * 1024 * 1024) continue;   // 同上
    text = readFileSync(file, "utf8");
  } catch { continue; }

  const status = readStatus(text);
  if (statusFilter && status !== statusFilter) continue;
  scannedDocs++;

  const rel = relative(KB, file);
  const fname = basename(file);
  const lines = text.split(/\r?\n/);

  // 文件名命中：只看文件名本身，不看目录路径。
  // 原实现是 fname + rel，而 rel 里必然含 '事实\' '产出\' '学科资料\' 这些通用字，
  // 于是几乎每个文件都显示「文件名命中」——这个标记就没有区分度了。
  const nameLow = fname.toLowerCase().replace(/[\s_\-]+/g, "");
  const nameWordIdxs = [];
  for (let wi = 0; wi < wordTermSets.length; wi++) {
    const w = wordTermSets[wi];
    if (w.terms.some(t => nameLow.includes(t.replace(/[\s_\-]+/g, "")))) nameWordIdxs.push(wi);
  }
  const nameHit = nameWordIdxs.length > 0;

  const hits = [];               // { line, text, weight, coverage, wordIdxs, page, exact }
  let fullCoverRows = 0;
  let anyCoverRows = 0;

  // 行去掉空格/连字符后的紧凑形态，供「整串命中」判定用（含跨行拼接）
  const PACKED_LINES = lines.map(l => l.toLowerCase().replace(/[\s_\-]+/g, ""));

  // 原文文件里每页前面有【p123】或【p?|pdf45】标记。扫的时候记着「当前在第几页」，
  // 命中行就能带上页码——引用时不用再回原文翻一遍。
  const PAGE_MARK = /^【p(\d+|\?)(?:\|pdf(\d+))?】/;
  let curPage = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pm = PAGE_MARK.exec(line);
    if (pm) {
      curPage = pm[1] === "?" ? (pm[2] ? `p?/${pm[2]}` : null) : `p${pm[1]}`;
      continue;                    // 标记行本身不参与打分
    }
    if (!line.trim()) continue;
    const low = line.toLowerCase();
    const lowPacked = low.replace(/[\s_\-]+/g, "");

    let matchedWords = 0;
    let occ = 0;
    const wordIdxs = [];
    let termTotal = 0;          // 本行触及的 term 总数（coverage 的分母）
    let termHit = 0;            // 实际命中的 term 数
    for (let wi = 0; wi < wordTermSets.length; wi++) {
      const w = wordTermSets[wi];
      let hitThis = false;
      for (const t of w.terms) {
        termTotal++;
        if (low.includes(t) || lowPacked.includes(t.replace(/[\s_\-]+/g, ""))) {
          hitThis = true; occ++; termHit++;
        }
      }
      if (hitThis) { matchedWords++; wordIdxs.push(wi); }
    }
    if (matchedWords === 0) continue;

    // ── 整串门槛（2026-11-09 补，踩了两次才改对）──
    // 只按 bigram 命中就会出这种事：搜「异化劳动」，bigram = 异化|化劳|劳动，
    // 于是《资本论》里 6106 个「劳动」全算命中（实测：文集08 里「异化劳动」正文 0 处，
    // 却靠「劳动」蹭出 4521 个命中行），把真正写了 23 次的《1844年手稿》挤下去。
    // 这不是排序 bug，是「拆词后丢掉了词序」。
    // 判据：整串（去空格）在同一行或「本行+下一行」里出现过 → exact=true；
    //       只是 bigram 拼出来的 → exact=false，打分打三折。
    // 第一次改错的原因：拿 `packedLine + packedNext` 判整串，短查询没问题，
    // 但长句查询会把一整段都算「跨行命中」——所以限定跨行拼接只对 ≤24 字的串生效。
    const packedLine = lowPacked;
    // 2026-11-10 三修（用户实测曝出，最要紧的一条）：
    //   查「在它所能容纳的全部生产力发挥出来以前」匹配不到《文集》第2卷，
    //   因为它被拆成两行：
    //     L16842: …无论哪一个社会形态，在它所能容纳的全部生产
    //     L16843: 力发挥出来以前，是决不会灭亡的s 而新的更高的生产关系…
    //   而判据是 `nd.length <= 24` 才允许跨行拼——这句拼起来 38 字，被挡在门外。
    //   只有《全集》第12卷那处是单行完整，所以只有它命中。
    // 现在：改成 **3 行滑窗 + 不限长度**（长度限制本来是为了防止长句把整段
    //      都算跨行命中，但滑窗到 3 行已经能控制住，不需要再限长度）。
    const packedWin = [0, 1, 2]
      .map((k) => (i + k < lines.length ? PACKED_LINES[i + k] ?? "" : ""))
      .join("");
    let exactHit = false;
    let crossHit = false;
    for (const ws of wordTermSets) {
      const nd = ws.raw.toLowerCase().replace(/[\s_\-]+/g, "");
      if (!nd) continue;
      if (packedLine.includes(nd)) { exactHit = true; break; }
      if (packedWin.includes(nd)) { exactHit = true; crossHit = true; break; }
    }

    // exact=false 的行，如果它连「原查询的第一个字」都没碰到，直接丢——
    // 只靠最后一个 bigram（如「劳动」）蹭进来的行，对查询毫无贡献。
    if (!exactHit && !wordTermSets.some(ws => {
      const head = ws.raw.toLowerCase().replace(/[\s_\-]+/g, "").slice(0, 2);
      return head && packedLine.includes(head);
    })) continue;

    // ── 长词硬门槛（2026-11-10 用户实测曝出）──
    // 查「两个决不会」，bigram = 两个|个决|决不|不会，
    // 于是凡含「两个」的文件全算命中——实测 **1073 个文件**，
    // 前三条是「两个工人的疑问」「……的两个文件」，跟查询毫无关系。
    // 判据：查询词去空格后 **≥4 字** 时，必须整串命中（exactHit=true）才收。
    // 理由：4 字以上的词，部分命中几乎必然是噪音；2–3 字（如「异化」「劳动」）
    // 才允许 bigram 模糊匹配（那些词短，拆开也还有意义）。
    const LONG_QUERY = 4;
    if (!exactHit && wordTermSets.some(ws => ws.raw.replace(/[\s_\-]+/g, "").length >= LONG_QUERY)) continue;

    // 全库词频：只按文件记一次即可
    for (const wi of wordIdxs) wordDocFreq[wi].add(file);

    const isH1 = /^#\s/.test(line.trim());
    const isH2 = /^#{2,3}\s/.test(line.trim());

    let weight = 1;
    if (isH1) weight = 8;
    else if (isH2) weight = 4;

    // ── 关键：coverage 按 term（bigram）算，不按输入词算 ──
    // 原实现 matchedWords/wordTermSets.length。问题是「知识库分区整理」只是**一个**输入词，
    // 它被拆成 知识/识库/库分/分区/区整/整理 等 bigram 后，只要命中任意一个
    // matchedWords 就等于 1，coverage = 1/1 = 100%，于是「只沾了个『知识』」
    // 也被标成「全词命中」。这是 576 个文件同时满分的真正原因。
    //
    // 2026-11-10 四修：**跨行拼合命中的，coverage 也算满分**。
    //   事故：查《序言》名句，3 行滑窗已经能拼出完整句子（exactHit=true），
    //   但 termHit 只在行内统计（low.includes），跨行时每个 bigram 都只命中一部分，
    //   于是 coverage 很低、被标成「仅部分词命中」，排序上被压到末位。
    //   既然整串都能拼出来，coverage 就没有理由不给满分。
    let coverage = termTotal > 0 ? (termHit / termTotal) : 0;
    if (exactHit) coverage = Math.max(coverage, 1.0);
    const density = Math.log2(1 + occ);

    if (titleOnly && !isH1 && !isH2) continue;

    hits.push({ line: i + 1, text: line.trim().slice(0, 180), weight, coverage, density, wordIdxs, page: curPage, exact: exactHit });
    anyCoverRows++;
    if (coverage >= 0.999) fullCoverRows++;
  }

  if (hits.length === 0) continue;

  docs.push({
    file, rel, name: fname, status, nameHit, nameWordIdxs,
    lineCount: lines.length,
    hits, anyCoverRows, fullCoverRows,
  });
}

// ── IDF：词越常见，权重越低 ──
// 通用词（'知识' 命中 523 个文件）几乎不提供区分度，专用词（'四态判据'）才值钱。
// 用经典平滑式 log((N+1)/(df+0.5))，再归一化到 [0.15, 1]，避免常见词被归一到 0 后整个查询失效。
const N = Math.max(scannedDocs, 1);
const idf = wordDocFreq.map(set => {
  const df = set.size;
  const raw = Math.log((N + 1) / (df + 0.5));
  return Math.max(raw, 0);
});
const idfMax = Math.max(...idf, 1e-9);
const wordWeight = idf.map(v => 0.15 + 0.85 * (v / idfMax));

// ── 第二遍：打分（数据都在内存里，不重读磁盘）──
for (const d of docs) {
  let rawSum = 0;
  for (const h of d.hits) {
    // 词级 IDF 参与：只有通用词命中的行，分数会被压低
    let idfFactor = 0;
    for (const wi of h.wordIdxs) idfFactor += wordWeight[wi];
    idfFactor /= Math.max(h.wordIdxs.length, 1);

    h.score = h.weight * (1 + h.coverage * h.coverage * 4) * (1 + h.density * 0.5) * idfFactor;
    // 整串命中 vs 只是 bigram 拼凑：三折之差。
    // 「异化劳动」在《文集》第1卷出现 23 次、《文集》第8卷 14 次，而第8卷「劳动」有 6106 处——
    // bigram 拆开算，第8卷会把第1卷压死。整串命中才算数，词序就回来了。
    if (!h.exact) h.score *= 0.3;
    // 参考性文件降权（2026-11-10，与 quote.mjs 同一处修复）：
    // MEGA 年鉴的目录页（inhalt/einfuehrung）有人名索引，命中数天然高，
    // 查「Borkheim」时 138 处压过真正 246 封书信的 98 处。
    // 目录是「提到谁」，不是「谁写的」——打四折。
    if (/inhalt|einfuehrung|einf|register|prospekt|korrigenda|_index/i.test(d.rel || d.path || "")) h.score *= 0.4;
    // 目录行不算正文命中（2026-11-09 再修）：
    // 第8卷里「异化劳动」的 14 处全在目录和小标题（`[异化劳动和资本…] … 98`），
    // 正文一处没有；而第1卷 23 处是实打实的论述。目录行打一折——
    // 它是「这本书里提到过」，不是「马克思在这里说过」。
    if (DOTS_LINE.test(h.text)) h.score *= 0.1;
    rawSum += h.score;
  }

  const fullRatio = d.anyCoverRows > 0 ? d.fullCoverRows / d.anyCoverRows : 0;

  // 长度归一化（BM25 思路）：按行数平方根压。开方而非线性，长文本来就更可能多命中几行。
  const BASE_LINES = 120;
  const lenNorm = Math.sqrt(Math.max(d.lineCount, 1) / BASE_LINES);
  let fileScore = rawSum / Math.max(lenNorm, 1);

  fileScore *= (0.35 + 0.65 * fullRatio);

  // 文件名加权：命中的词越专门，加成越高。命中常见的 '知识' 只值几十分，
  // 命中专门的 '四态判据' 才拿满。这样「文件名对上」不再被通用词蹭走。
  let nameBonus = 0;
  if (d.nameWordIdxs.length > 0) {
    const avgW = d.nameWordIdxs.reduce((s, wi) => s + wordWeight[wi], 0) / d.nameWordIdxs.length;
    const coverRatio = d.nameWordIdxs.length / wordTermSets.length;
    nameBonus = 60 * avgW * (0.4 + 0.6 * coverRatio);
  }
  fileScore += nameBonus + Math.min(d.fullCoverRows, 8) * 3;
  fileScore *= STATUS_PENALTY[d.status] ?? 1;

  // ── 2026-11-10 新增：TOC 标题命中加分 ──
  //   事故：查「劳动的二重性」，命中最多的是「根源于劳动的二重性」这类叙述句，
  //   真正的章节标题「2. 体现在商品中的劳动的二重性」（文集05 p54）反而沉底。
  //   判据：命中的行所在页，如果该页在 TOC 里的标题正好包含查询词，加 80 分。
  //   只认「标题包含查询词」的，不认「页面落在某个区间」——后者太宽。
  {
    const relNorm = (d.rel || "").replace(/\\/g, "/");
    const tocArr = TOC_BY_REL[relNorm];
    if (tocArr && d.hits.length) {
      const q = words.join("");
      let tocBonus = 0;
      for (const h of d.hits.slice(0, 20)) {
        const pg = parseInt(h.page, 10);
        if (!pg) continue;
        for (const x of tocArr) {
          if (x.start <= pg && pg <= x.end && String(x.name || "").includes(q)) {
            tocBonus = 80;
            break;
          }
        }
        if (tocBonus) break;
      }
      fileScore += tocBonus;
    }
  }

  // ── 2026-11-10 五修：L0 整串命中加「定锚分」，与长度归一化脱钩 ──
  //   事故：查《序言》名句，「文集02」已经全词命中 2/2 行（coverage 满分），
  //   但分数只有 16.4——因为 lenNorm 用 √(行数/120) 归一，1865 KB 的大书
  //   被压到 sqrt(29863/120)=15.8 倍，rawSum 再高也剩不下多少。
  //   结果 L2 阿尔都塞（短文件）95.7 压过 L0 原文 16.4。
  //   这对「引原文」是反的：越是整卷原著，越被字数惩罚。
  // 判据：**整串命中且有页码**的 L0，每命中一行加 40 分定锚分（上限 3 行）。
  //   只加 L0，只加有页码的，避免把无页码的网页源也抬上来。
  {
    const rel0 = d.rel || "";
    if (/(^|[\\/])L0-/.test(rel0)) {
      const anchored = d.hits.filter((h) => h.exact && h.page && !String(h.page).startsWith("?")).length;
      if (anchored > 0) fileScore += Math.min(anchored, 3) * 40;
    }
  }

  // ── 分层权重（2026-11-09 扩到五层）──
  // 目标要求分五层。援引地位不一样，不能都算「原文」：
  //   L0 马恩列原著        × 2.2  —— 引用落点，唯一能写成「《文集》第X卷，pNNN」
  //   L1 中国化马克思主义   × 2.0  —— 考 0302 直接要，毛泽东为最高
  //   L2 西方马克思主义     × 1.5  —— 844 常考（卢卡奇/葛兰西/阿尔都塞），但多为转述
  //   L3 相邻理论家         × 1.3  —— 黑格尔/费尔巴哈/斯宾诺莎/拉康，作背景不主引
  //   L4 苏东与经典阐释     × 1.2  —— 普列汉诺夫等，考到就引
  //   L5 其他/反面观点      × 1.1  —— 哈耶克/凯恩斯/斯密，批判用
  //   教材（马发史等）      × 1.6  —— 有页码但不是原著
  //   其余（笔记/导图/对话）× 1.0
  // 为什么 L0 仍是最高：0302 的论述题，引马恩列是硬通货；引卢卡奇是加分，不能顶替。
  const rel = d.rel;
  let layer = null;
  if (/(^|[\\/])L0-/.test(rel)) layer = "L0";
  else if (/(^|[\\/])L1-/.test(rel)) layer = "L1";
  else if (/(^|[\\/])L2-/.test(rel)) layer = "L2";
  else if (/(^|[\\/])L3-/.test(rel)) layer = "L3";
  else if (/(^|[\\/])L4-/.test(rel)) layer = "L4";
  else if (/(^|[\\/])L5-/.test(rel)) layer = "L5";
  // 2026-11-14 新增：M 层 = 毛泽东古籍批注
  //   为什么单列：这里面装的是两样东西——
  //     ① 古籍原文（二十四史等，3800 万字）—— 引用落点，但不是马恩列，不能按 L0 算
  //     ② 毛批原文（338 条，从中央文献1993扫描件左栏提出来的）—— 一手材料，价值高于任何转述
  //   实测问题（2026-11-14）：查「打运动战」，M 层毛批《陆逊传》那条进不了前三，
  //   被 L0 马恩全集、L1 朱德选集、L1 陈云文选压住，因为 M 层无系数（按 1.0 算）。
  //   定 1.9：高于 L1(2.0)? 不。定 1.9 低于 L1，但高于 L2。
  //   理由：0302 考卷上引毛批是加分项，引选集正文才是主力；毛批价值高，但不当考纲原文用。
  else if (/(^|[\\/])M-/.test(rel)) layer = "M";
  // 兼容旧路径（本轮迁移前抓的，已搬进 L0，但万一有残留）
  else if (/(^|[\\/])原著原文[\\/]/.test(rel)) layer = "L0";
  else if (/(^|[\\/])教材原文[\\/]/.test(rel)) layer = "教材";

  const isTextbook = layer === "教材" || /教材-/.test(basename(rel));
  const isOriginal = layer !== null && layer !== "教材";
  if (layer && LAYER_BOOST[layer] !== undefined) fileScore *= LAYER_BOOST[layer];
  else if (isTextbook) fileScore *= TEXTBOOK_BOOST;

  const hits = d.hits.slice().sort((a, b) => b.score - a.score);
  results.push({
    file: d.rel,
    name: d.name,
    status: d.status,
    nameHit: d.nameHit,
    isOriginal,
    isTextbook,
    layer,
    score: fileScore,
    hits: hits.slice(0, 3),
    totalHits: hits.length,
    fullCoverRows: d.fullCoverRows,
    fullRatio,
  });
}

results.sort((a, b) => b.score - a.score);
const shown = results.slice(0, limit);

if (shown.length === 0) {
  console.log(`未命中：「${words.join(" ")}」${statusFilter ? ` (status=${statusFilter})` : ""}`);
  console.log("提示：换关键词、用 -t 只搜标题、-a 含素材目录，或 --status obsolete 看废弃条目。");
  process.exit(0);
}

const STATUS_TAG = { obsolete: "🛑作废", superseded: "⚠️已取代", corrected: "✎部分更正" };
console.log(`命中 ${results.length} 个文件，显示前 ${shown.length}（关键词：${words.join(" ")}${statusFilter ? " · status=" + statusFilter : ""}）\n`);

for (const r of shown) {
  const tag = STATUS_TAG[r.status] ? ` ${STATUS_TAG[r.status]}` : "";
  const cover = r.fullRatio > 0 ? ` · 全词命中 ${r.fullCoverRows}/${r.totalHits} 行` : " · 仅部分词命中";
  const orig = r.isOriginal
    ? (r.layer ? ` 📖${r.layer}` : " 📖原著")
    : (r.isTextbook ? " 📘教材" : "");
  console.log(`📄 ${r.file}${tag}${orig}  [分 ${r.score.toFixed(1)} · 命中 ${r.totalHits} 行${cover}${r.nameHit ? " · 文件名命中" : ""}]`);
  for (const h of r.hits) {
    const pg = h.page ? `${h.page} ` : "";
    console.log(`   ${String(h.line).padStart(5)} │ ${pg}${h.text}`);
  }
  console.log("");
}
