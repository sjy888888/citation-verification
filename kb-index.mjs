#!/usr/bin/env node
/**
 * kb-index.mjs — 知识库总目录自动生成器（忠实索引，不再是摘要库）
 *
 * 用法：
 *   node kb-index.mjs              重建 索引/总目录.md
 *   node kb-index.mjs --check      只检查，不写文件（覆盖率 + 死链 + 表头）
 *   node kb-index.mjs --dry        打印将生成的内容，不落盘
 *
 * 设计原则：
 *   1. 一行一个文件，一句话（≤60 字）——目录的职能是定位，不是讲结论
 *   2. 覆盖 100%：扫描目录下的所有 .md，不是靠人记得写
 *   3. 死链检测：目录里提到的文件必须真实存在，否则报错
 *   4. 描述来源优先级：front matter summary > 引用块首行 > H1 > 文件名去日期
 *
 * 关联：《2026-10-27-知识库体检-不足与整改建议.md》
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

const KB = "G:/path/to/knowledge-base";
const OUT = join(KB, "索引", "总目录.md");

// 扫描范围：按渲染顺序排
// include: 该段收录哪些扩展名（null = 不限，但受 SKIP_DIRS/SKIP_PATTERNS 约束）
const SECTIONS = [
  { key: "事实",      dir: "事实",      title: "一、事实/（可复用结论）",   include: [".md"] },
  { key: "决策",      dir: "决策",      title: "二、决策/（拍板的事）",     include: [".md"] },
  { key: "学科资料",  dir: "学科资料",  title: "三、学科资料/（题库·汇编·思维导图）", include: [".md"] },
  { key: "工具",      dir: "工具",      title: "四、工具/（可复用脚本）",   include: [".mjs", ".cjs", ".ps1", ".py", ".cmd", ".bat"] },
  { key: "文档",      dir: "文档",      title: "五、文档/（原始资料）",     include: [".md", ".pdf", ".epub"] },
  { key: "ima对话",   dir: "ima对话",   title: "六、ima对话/（ima 会话导出）", include: [".md"] },
  { key: "文献库",    dir: "文献库",    title: "七、文献库/",              include: [".bib"] },
];

// 不扫的子目录（中间产物、垃圾、暂存）
const SKIP_DIRS = new Set([
  "pages", "node_modules", "_raw", "_gh", "_work", "ima_files_dump",
  "law_upload_staging", "凭证", "out", "shots", "src", "deliver", "tmp",
]);

// 不收录的文件名模式：时间戳目录 / 临时探针 / 下划线开头的中间产物
const SKIP_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/, // 2026-09-18T20-31-51 这类快照目录
  /^_/,                                    // _qa_lib.json / _mkpdf.py
  /^\./,
];

const DESC_MAX = 60;

function* walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (SKIP_PATTERNS.some(re => re.test(e.name))) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (e.isFile()) yield p;
  }
}

/** 解析 front matter（--- ... ---） */
function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

/** 状态标记：目录里要一眼看出这条还能不能信 */
const STATUS_MARK = {
  obsolete:   { icon: "🛑", label: "作废",   strike: true  },
  superseded: { icon: "⚠️", label: "已被取代", strike: true  },
  corrected:  { icon: "✎",  label: "部分更正", strike: false },
};

/** 判断一段文本是不是"空话"——只有日期、只有状态、只有元信息 */
function isJunk(t) {
  const s = t.replace(/[*_`>\s]/g, "");
  if (s.length < 6) return true;
  // 纯日期 / 日期+括注
  if (/^\d{4}[-年]\d{1,2}([-月]\d{1,2})?[日]?[（(].*[）)]?$/.test(s)) return true;
  if (/^(落库|记录|创建|更新|生成|撰写)日期[:：]?\d{0,}/.test(s)) return true;
  if (/^日期[:：]?\d/.test(s)) return true;
  if (/^状态[:：]/.test(s)) return true;
  if (/^来源[:：]/.test(s)) return true;
  // 只有年份区间
  if (/^\d{4}[-—~至]\d{4}$/.test(s)) return true;
  return false;
}

// 非文本格式：按扩展名给一句类型标签，绝不读内容（PDF 二进制读进来是乱码）
const TYPE_LABEL = {
  ".pdf":    "PDF 原件",
  ".epub":   "EPUB 电子书",
  ".bib":    "参考文献库（BibTeX）",
  ".csv":    "CSV 数据表",
  ".json":   "JSON 数据",
  ".png":    "图片",
  ".jpg":    "图片",
  ".html":   "HTML 页面",
  ".docx":   "Word 文档",
  ".xlsx":   "Excel 表格",
};

/** 文件大小的人读表述 */
function sizeLabel(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 从文件里抽一句话描述（只对纯文本）。返回 { desc, status } */
function describe(file, baseName, ext, size) {
  const isText = [".md", ".txt"].includes(ext);

  // 非文本：类型 + 体积，不读内容
  if (!isText) {
    const label = TYPE_LABEL[ext] ?? ext.replace(".", "").toUpperCase();
    return { desc: `${label} · ${sizeLabel(size)}`, status: null };
  }

  let text;
  try {
    if (size > 2 * 1024 * 1024) return { desc: `文本 · ${sizeLabel(size)}（超大，未解析）`, status: null };
    text = readFileSync(file, "utf8");
  } catch { return { desc: null, status: null }; }

  const fm = parseFrontMatter(text);
  const status = fm.status ?? null;

  if (fm.summary) return { desc: clip(fm.summary), status };

  const lines = text.replace(/^---[\s\S]*?---\r?\n/, "").split(/\r?\n/);

  // H1：作者亲手写的标题，通常比文件名更精确
  let h1 = null;
  for (const l of lines) {
    const m = l.match(/^#\s+(.+)$/);
    if (m) { h1 = m[1].trim(); break; }
  }

  // 引用块首行（跳过纯日期/状态/来源这类元信息）
  const quotes = [];
  for (const l of lines) {
    const m = l.match(/^>\s*(.+)$/);
    if (!m) continue;
    const t = m[1].replace(/^[*_`\s]+/, "").trim();
    if (isJunk(t)) continue;
    quotes.push(t);
    if (quotes.length >= 2) break;
  }

  // 正文第一段实质内容（兜底）
  let para = null;
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith("#") || t.startsWith("|") || t.startsWith(">") || t.startsWith("```")) continue;
    if (isJunk(t)) continue;
    para = t;
    break;
  }

  const nameStem = baseName.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.(md|txt)$/i, "");

  // 主路径：H1。作者亲手写的标题就是最准的一句话，不再拼接，保持一行干净。
  if (h1 && !isJunk(h1) && h1.replace(/[*_`]/g, "").length >= 8) {
    return { desc: clip(h1), status };
  }

  // H1 缺失或过于简陋：用引用块，再用正文首段兜底
  if (quotes.length) return { desc: clip(quotes[0]), status };
  if (para) return { desc: clip(para), status };
  return { desc: clip(nameStem), status };
}

function clip(s, max = DESC_MAX) {
  // 去掉 markdown 强调符，压平空白
  let t = s.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  // 去掉开头的"一句话"式前缀，避免占位
  t = t.replace(/^(一句话|结论先行|核心一句)[:：]\s*/, "");
  if (t.length > max) {
    // 优先在标点处断，不要生切
    const cut = t.slice(0, max);
    const lastPunct = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf("，"), cut.lastIndexOf("、"));
    t = lastPunct > max * 0.55 ? cut.slice(0, lastPunct + 1) : cut.slice(0, max - 1) + "…";
  }
  return t;
}

/** 排序键：有日期的按日期倒序，无日期的排后面按名称 */
function sortKey(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})-/);
  return m ? ["2", `${m[1]}${m[2]}${m[3]}`, name] : ["1", "00000000", name];
}

function collect(section) {
  const dir = join(KB, section.dir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of walk(dir)) {
    const name = basename(f);
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    if (section.include && !section.include.includes(ext)) continue;
    const size = (() => { try { return statSync(f).size; } catch { return 0; } })();
    const { desc, status } = describe(f, name, ext, size);
    out.push({
      name,
      rel: relative(KB, f).replace(/\\/g, "/"),
      desc,
      status,
      size,
    });
  }
  out.sort((a, b) => {
    const ka = sortKey(a.name), kb2 = sortKey(b.name);
    if (ka[0] !== kb2[0]) return ka[0] < kb2[0] ? 1 : -1;   // 有日期的在前
    if (ka[1] !== kb2[1]) return ka[1] < kb2[1] ? 1 : -1;   // 日期倒序
    return ka[2].localeCompare(kb2[2], "zh");
  });
  return out;
}

function build() {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const lines = [];
  let sectionCount = 0;
  lines.push("# 知识库总目录（全窗口共享索引）");
  lines.push("");
  lines.push("> 本文件是 `G:\\path\\to\\knowledge-base\\` 的导航目录。任何窗口开工前先扫这里，按主题定位已有成果。");
  lines.push("> **本文件由 `工具/kb-index.mjs` 自动生成，勿手改。** 改动请改对应 md 的 H1 或 `front matter: summary`，然后重跑脚本。");
  lines.push(`> 生成时间：${stamp}`);
  lines.push("> 命名与落点约定见《README.md》；详细结论在各自文件正文里，本目录只给一句话定位。");
  lines.push("");

  let total = 0;
  const manifest = [];   // 供 --check 核对

  for (const sec of SECTIONS) {
    const items = collect(sec);
    total += items.length;
    lines.push(`## ${sec.title}（${items.length}）`);
    lines.push("");
    if (items.length === 0) {
      lines.push("_（空）_");
      lines.push("");
      continue;
    }
    sectionCount++;
    lines.push("| 文件 | 一句话 |");
    lines.push("|---|---|");
    for (const it of items) {
      const mark = it.status && STATUS_MARK[it.status];
      const desc = it.desc ?? "";
      // 作废/被取代的加删除线，一眼看出不能直接用
      const nameCell = mark?.strike
        ? `~~[${it.name}](<${it.rel}>)~~`
        : `[${it.name}](<${it.rel}>)`;
      const prefix = mark ? `${mark.icon} **${mark.label}** · ` : "";
      const descCell = mark?.strike
        ? `~~${prefix}${desc}~~`
        : `${prefix}${desc}`;
      lines.push(`| ${nameCell} | ${descCell} |`);
      manifest.push({ section: sec.key, name: it.name, rel: it.rel, status: it.status });
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## 附录：本目录不收录的目录");
  lines.push("");
  lines.push("| 目录 | 说明 |");
  lines.push("|---|---|");
  lines.push("| `产出/` | 成品与报告，**按项目自组织**。找成品请直接浏览目录或用 `工具/kb.mjs` 检索。 |");
  lines.push("| `索引/` | 本文件所在处；`ima_files_dump`、`law_upload_staging` 为暂存副本，不索引。 |");
  lines.push("| `素材/` `凭证/` | 原始素材与加密凭据，不索引。 |");
  lines.push("| `归档/` | 历史与备份，不索引。 |");
  lines.push("");
  lines.push(`**收录合计：${total} 个文件/脚本。**`);
  lines.push("");

  return { text: lines.join("\n"), total, manifest, sectionCount };
}

// ── --check：只诊断不写 ──────────────────────────────
function check() {
  const { total } = build();

  // 1) 覆盖率：每个扫描目录下应被收录的文件 vs 实际收录
  let expected = 0;
  for (const sec of SECTIONS) expected += collect(sec).length;

  // 2) 死链：扫描所有 md 里形如 `事实/xxx.md` 的引用，检查是否存在
  //    三种终态，只有一种算病：
  //      a. 目标存在                      → 正常
  //      b. 目标不在、但有同名 .enc        → 已加密（合法终态，加密见决策/2026-10-13）
  //      c. 目标不在、且同行明写了失档标记 → 已宣告失档（合法终态，见下）
  //      d. 目标不在、也没宣告            → 死链（判 FAIL）
  //    c 的判据：引用所在那一行里出现「已失 / 全盘无副本 / 原件已失」等字样。
  //    这条是 2026-11-05 加的：原判据只有 a/b 两态，把「已知丢失并记账」的历史引用
  //    也报成死链，逼人删引用——那是让账消失，不是修账。
  const refRe = /(?:事实|决策|产出|工具|索引|学科资料|文档|文献库)[\\/]([^\s`》\)|]+?\.(?:md|py|mjs|cjs|jsonl|json|txt|ps1|yml|yaml|html|pdf|epub|csv|bib|zstd|ps1))/g;
  const LOST_MARK = /已失|全盘无副本|原件已失|已遗失/;
  // occ: ref -> { from, declared }[] ；先全收，再按「最坏状态优先」定级
  const occ = new Map();
  const encrypted = [];
  for (const sec of SECTIONS) {
    const dir = join(KB, sec.dir);
    if (!existsSync(dir)) continue;
    for (const f of walk(dir)) {
      if (!f.toLowerCase().endsWith(".md")) continue;
      let text;
      try {
        if (statSync(f).size > 2 * 1024 * 1024) continue;
        text = readFileSync(f, "utf8");
      } catch { continue; }
      const lines = text.split(/\r?\n/);
      let m;
      while ((m = refRe.exec(text))) {
        const rel = m[0].replace(/\//g, "/").replace(/\\/g, "/");
        // 占位符模板（如 `产出/<日期>-*.md`、`事实/xxx.md`）不是真引用，跳过。
        // xxx / XXX / foo / bar / YYYY 这类显然不是真文件名——2026-11-05 加，
        // 因为流程文档里写「把 `事实/xxx.md` 改成 `事实/xxx.md.enc`」会被自己抓到。
        if (/[<>*]/.test(rel)) continue;
        if (/[/\\](?:xxx|XXX|foo|bar|yyy|YYY|placeholder)[^/\\]*\./i.test(rel)) continue;
        if (existsSync(join(KB, rel))) continue;
        // 已加密：同名 .enc 存在 → 合法终态，单独统计，不计死链
        if (existsSync(join(KB, rel + ".enc"))) {
          if (!encrypted.some(e => e.ref === rel)) {
            encrypted.push({ from: relative(KB, f), ref: rel });
          }
          continue;
        }
        // 目标确实不在：这一行的作者有没有明写「失档」？
        const lineText = lines.find(l => l.includes(m[0]));
        const declared = !!(lineText && LOST_MARK.test(lineText));
        if (!occ.has(rel)) occ.set(rel, []);
        occ.get(rel).push({ from: relative(KB, f), declared });
      }
    }
  }
  // 归并：一个引用只要有一处「默认为它还在」（未宣告失档），就算死链。
  // 全是宣告过失档的，才算合法的失档记账。
  const dead = [];
  const lost = [];
  for (const [ref, list] of occ) {
    const silent = list.find(o => !o.declared);
    if (silent) dead.push({ from: silent.from, ref });
    else lost.push({ from: list[0].from, ref });
  }

  // 3) 表头健康度：新格式每节一个表头。判据 = 表头数应等于非空小节数；
  //    出现旧摘要体的「结论主题」表头，说明文件被手工回填过旧内容。
  let headers = 0, legacyHeaders = 0;
  if (existsSync(OUT)) {
    for (const l of readFileSync(OUT, "utf8").split(/\r?\n/)) {
      if (/^\|\s*文件\s*\|\s*一句话\s*\|/.test(l)) headers++;
      if (/^\|\s*文件\s*\|\s*结论主题\s*\|/.test(l)) legacyHeaders++;
    }
  }

  // 统计本次 build 里实际有多少个非空小节
  const { sectionCount } = build();

  const out = [];
  out.push("kb-index --check");
  out.push(`  覆盖：${total} 个文件（扫描目录 ${SECTIONS.map(s => s.dir).join("、")}）`);
  out.push(`  预期：${expected} 个`);
  out.push(`  死链：${dead.length} 条`);
  if (dead.length) {
    for (const d of dead.slice(0, 30)) out.push(`    ✗ ${d.from} → ${d.ref}`);
    if (dead.length > 30) out.push(`    … 另有 ${dead.length - 30} 条`);
  }
  if (encrypted.length) {
    out.push(`  已加密（合法，不计死链）：${encrypted.length} 条`);
    for (const d of encrypted.slice(0, 10)) out.push(`    🔒 ${d.from} → ${d.ref}.enc`);
    if (encrypted.length > 10) out.push(`    … 另有 ${encrypted.length - 10} 条`);
  }
  if (lost.length) {
    out.push(`  已宣告失档（合法，不计死链）：${lost.length} 条`);
    for (const d of lost.slice(0, 10)) out.push(`    📕 ${d.from} → ${d.ref}`);
    if (lost.length > 10) out.push(`    … 另有 ${lost.length - 10} 条`);
  }
  out.push(`  表头：${headers} 个（非空小节 ${sectionCount} 个）${headers === sectionCount ? " ✓" : " ⚠ 数量不符（改完 SECTIONS 后没重建）"}`);
  if (legacyHeaders) out.push(`    ⚠ 残留旧摘要体表头 ${legacyHeaders} 处（「结论主题」）——文件被手工改过`);

  // 4) 状态位统计：目录里有多少条不能直接信
  const { manifest } = build();
  const byStatus = {};
  for (const m of manifest) {
    const k = m.status ?? "active";
    byStatus[k] = (byStatus[k] ?? 0) + 1;
  }
  const marked = (byStatus.obsolete ?? 0) + (byStatus.superseded ?? 0) + (byStatus.corrected ?? 0);
  out.push(`  状态位：已标注 ${marked} 条（obsolete ${byStatus.obsolete ?? 0} / superseded ${byStatus.superseded ?? 0} / corrected ${byStatus.corrected ?? 0}）`);

  out.push("");
  const ok = dead.length === 0 && total === expected && headers === sectionCount && legacyHeaders === 0;
  out.push(ok ? "判定：PASS（覆盖完整，死链 0，结构正常）" : "判定：FAIL");
  console.log(out.join("\n"));

  return ok;
}

// ── main ────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes("--check")) {
  process.exit(check() ? 0 : 1);
}

const { text, total } = build();

if (argv.includes("--dry")) {
  console.log(text);
  console.log(`\n[dry] 共 ${total} 条，未写盘。`);
  process.exit(0);
}

// UTF-8 无 BOM 写入（PS 5.1 的 UTF8 带 BOM，node 这边必须显式关掉）
writeFileSync(OUT, text, { encoding: "utf8" });
console.log(`已生成 ${OUT}`);
console.log(`  收录 ${total} 条`);
console.log(`  字节 ${Buffer.byteLength(text, "utf8")}`);
console.log(`  复查：node kb-index.mjs --check`);
