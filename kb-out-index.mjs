import fs from "node:fs";
import path from "node:path";

/**
 * kb-out-index.mjs — 产出/ 分区目录生成器（2026-11-06 新增）
 *
 * 为什么单独做一份：
 *   总目录（kb-index.mjs）明示不收录 产出/（README 说「按项目自组织，找成品请浏览目录」）。
 *   但实测 256 个扁平文件靠「浏览」是找不到的：
 *     搜「2026-11-05-263到350这笔账」→ 第一名是别的事实条目
 *     搜「2026-10-19-南开备考总手册」  → 第一名是别处的调研笔记
 *   一半查询找不到正主。所以产出需要自己的、按时间排的目录。
 *
 * 产出规则：
 *   - 根下扁平文件：一行一个，按日期倒序（这就是「流水产出」的主线）
 *   - 项目目录：只列**成品**（不展开 _work/pages 这类中间产物），给体积与文件数
 *   - 无日期前缀的：单独列在最后，标出来（这些是历史遗留，改名会断引用）
 */

const KB = "G:/path/to/knowledge-base";
const IN = path.join(KB, "产出");
const OUT = path.join(KB, "索引", "产出目录.md");

// 中间产物的目录名（不展开，只计数）
// 中间产物目录（整个跳过，只计体积）
// 2026-11-06 修：'raw' 曾经在名单里，结果 产出/00226主观题资料/raw/ 的
// 7 份真资料（考试大纲、真题答案、自考365问答汇总、复习笔记）被当成中间产物吞掉了，
// 那个项目在目录里显示「0 个成品」。
// 教训：目录名不能判内容——raw 可能是中间产物，也可能是原始资料。
// 所以 raw 移出名单，改由扩展名裁决（.txt/.md 一律算成品）。
const WORK_DIRS = new Set([
  "_work", "pages", "shots", "src", "deliver", "out", "tmp",
  "node_modules", "_upload",
]);

// 成品扩展名（要单独列的）
const DOC_EXT = new Set([".md", ".html", ".pdf", ".epub", ".docx", ".xlsx", ".pptx", ".txt", ".csv"]);

function sizeLabel(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 ** 3).toFixed(2) + " GB";
  if (bytes >= 1024 * 1024) return (bytes / 1024 ** 2).toFixed(1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}

/** 从 md 里抽一句话：front matter summary > H1 > 首段 */
function describe(file, ext) {
  if (![".md", ".txt"].includes(ext)) {
    const label = { ".html": "HTML 页面", ".pdf": "PDF", ".epub": "EPUB", ".docx": "Word", ".xlsx": "Excel", ".pptx": "PPT", ".csv": "CSV" }[ext] ?? ext;
    return label;
  }
  let t;
  try {
    if (fs.statSync(file).size > 1024 * 1024) return "文本（较大，未解析）";
    t = fs.readFileSync(file, "utf8");
  } catch { return ""; }

  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t);
  if (fm) {
    const s = /^summary:\s*(.+)$/m.exec(fm[1]);
    if (s) return clip(s[1]);
  }
  const h1 = /^#\s+(.+)$/m.exec(t);
  if (h1) return clip(h1[1]);

  const body = t.replace(/^---[\s\S]*?\n---\n/, "");
  for (const para of body.split(/\r?\n\r?\n/)) {
    const s = para.trim();
    if (!s || s.startsWith("#") || s.startsWith(">") || s.startsWith("|") || s.startsWith("```")) continue;
    if (s.length < 12) continue;
    return clip(s);
  }
  return "";
}

function clip(s, max = 60) {
  const t = s.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const p = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf("，"), cut.lastIndexOf("、"));
  return p > max * 0.55 ? cut.slice(0, p + 1) : cut.slice(0, max - 1) + "…";
}

// ── 扫描 ──
const entries = fs.readdirSync(IN, { withFileTypes: true });
const flat = [];      // 根下扁平文件
const projects = [];  // 项目目录
const noDate = [];    // 无日期前缀的（历史遗留）

for (const e of entries) {
  const full = path.join(IN, e.name);
  if (e.isDirectory()) {
    const files = [];
    (function walk(d, depth) {
      if (depth > 6) return;
      let es;
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const x of es) {
        const p = path.join(d, x.name);
        if (x.isDirectory()) {
          if (WORK_DIRS.has(x.name)) continue;   // 中间产物目录整个跳过
          walk(p, depth + 1);
        } else if (x.isFile()) {
          files.push(p);
        }
      }
    })(full, 0);

    // 中间产物体积（用于显示「另有 N MB 在 _work」）
    let workBytes = 0, workCount = 0;
    for (const w of WORK_DIRS) {
      const wp = path.join(full, w);
      if (!fs.existsSync(wp)) continue;
      (function walkW(d) {
        let es;
        try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const x of es) {
          const p = path.join(d, x.name);
          if (x.isDirectory()) walkW(p);
          else { try { workBytes += fs.statSync(p).size; workCount++; } catch {} }
        }
      })(wp);
    }

    let bytes = 0;
    for (const f of files) { try { bytes += fs.statSync(f).size; } catch {} }

    projects.push({
      name: e.name,
      count: files.length,
      bytes,
      workBytes, workCount,
      samples: files.slice(0, 3).map(f => path.basename(f)),
    });
  } else {
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    const ext = path.extname(e.name).toLowerCase();
    const rec = {
      name: e.name,
      rel: path.relative(KB, full).replace(/\\/g, "/"),
      size: st.size,
      mtime: st.mtime,
      desc: describe(full, ext),
      dated: /^\d{4}-\d{2}-\d{2}-/.test(e.name),
    };
    if (rec.dated) flat.push(rec);
    else noDate.push(rec);
  }
}

// 按日期倒序
const dateOf = n => (/^(\d{4})-(\d{2})-(\d{2})-/.exec(n) ?? [])[0] ?? "";
flat.sort((a, b) => dateOf(b.name).localeCompare(dateOf(a.name)) || a.name.localeCompare(b.name, "zh"));
noDate.sort((a, b) => b.mtime - a.mtime);
projects.sort((a, b) => a.name.localeCompare(b.name, "zh"));

// ── 写 ──
const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

const L = [];
L.push("# 产出/ 目录");
L.push("");
L.push("> 总目录（`索引/总目录.md`）**不收录 `产出/`**。这里是产出分区自己的目录。");
L.push("> **本文件由 `工具/kb-out-index.mjs` 自动生成，勿手改。**");
L.push(`> 生成时间：${stamp}`);
L.push("");
L.push("找成品按两种路径：**知道大概哪天** → 看下面按日期排的流水；**知道是哪个项目** → 看项目目录。");
L.push("");

L.push(`## 一、流水产出（根下 ${flat.length} 个，按日期倒序）`);
L.push("");
L.push("| 日期 | 文件 | 一句话 |");
L.push("|---|---|---|");
for (const f of flat) {
  const d = f.name.slice(0, 10);
  L.push(`| ${d} | [${f.name}](<${f.rel}>) | ${f.desc} |`);
}
L.push("");

L.push(`## 二、项目目录（${projects.length} 个）`);
L.push("");
L.push("> **只列成品**。项目内部的 `_work/` `pages/` 等中间产物不展开，另给体积。");
L.push("");
L.push("| 项目 | 成品 | 成品体积 | 中间产物 | 起始文件 |");
L.push("|---|---:|---:|---|---|");
for (const p of projects) {
  const work = p.workCount > 0 ? `${p.workCount} 文件 / ${sizeLabel(p.workBytes)}` : "—";
  const samples = p.samples.length ? p.samples.map(s => `\`${s}\``).join(" ") : "—";
  L.push(`| [${p.name}](<产出/${p.name}>) | ${p.count} | ${sizeLabel(p.bytes)} | ${work} | ${samples} |`);
}
L.push("");

if (noDate.length) {
  L.push(`## 三、无日期前缀（${noDate.length} 个，历史遗留）`);
  L.push("");
  L.push("> 这些不符合 `YYYY-MM-DD-标题` 约定。**没有批量改名**——它们大多被别处引用，改名会断链。");
  L.push("> 新建产出请务必带日期前缀。");
  L.push("");
  L.push("| 文件 | 大小 | 最后修改 | 一句话 |");
  L.push("|---|---:|---|---|");
  for (const f of noDate) {
    const d = f.mtime.toISOString().slice(0, 10);
    L.push(`| [${f.name}](<${f.rel}>) | ${sizeLabel(f.size)} | ${d} | ${f.desc} |`);
  }
  L.push("");
}

const totalFlatBytes = flat.reduce((s, f) => s + f.size, 0) + noDate.reduce((s, f) => s + f.size, 0);
const totalProjBytes = projects.reduce((s, p) => s + p.bytes + p.workBytes, 0);
L.push("---");
L.push("");
L.push(`**合计**：流水 ${flat.length} 个（${sizeLabel(totalFlatBytes)}）· 项目 ${projects.length} 个（${sizeLabel(totalProjBytes)}）· 无日期前缀 ${noDate.length} 个`);
L.push("");

fs.writeFileSync(OUT, L.join("\n"), "utf8");
console.log(`已生成 ${OUT}`);
console.log(`  流水 ${flat.length} · 项目 ${projects.length} · 无日期 ${noDate.length}`);
console.log(`  字节 ${Buffer.byteLength(L.join("\n"), "utf8")}`);
