#!/usr/bin/env node
/**
 * kb-status.mjs — 事实库状态位回填与校验
 *
 * 用法：
 *   node kb-status.mjs --audit    只报告：每条现在什么状态，哪些声明过时却没标
 *   node kb-status.mjs --apply    按 STATE_MAP 回填 front matter
 *   node kb-status.mjs --check    校验：status 合法性、supersedes 指向的文件是否存在
 *
 * 判据（不是凭印象）：
 *   obsolete    = 整篇结论作废，组件/版本已不存在，看了会误事
 *   superseded  = 有明确替代文档，保留作历史与踩坑记录
 *   corrected   = 部分章节过时，更正内容在本文内部（末尾更正节），不需外部承接
 *   active      = 现在还有效（默认，不写也行）
 *
 * 只改文件顶部 front matter，正文一个字不动。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const KB = "G:/path/to/knowledge-base";
const FACT = join(KB, "事实");

/**
 * 状态表。每一条都有判据出处——正文里哪句话定的性。
 * 新增条目必须写 reason，不许拍脑袋。
 */
const STATE_MAP = {
  "2026-09-16-OpenClaw商汤API配置与限流补丁.md": {
    status: "obsolete",
    reason: "正文第 5 行：2026-10-12 起作废，OpenClaw 已卸载，配置随删除不可恢复",
  },
  "2026-10-12-DSH三端定位与工作流.md": {
    status: "superseded",
    supersedes: "2026-10-13-DSH两端定位与工作流.md",
    reason: "正文第 3 行：本文档已过时，请读新版；旧验证端 19388 已删除，val2 接任",
  },
  "2026-10-18-DSH0.2.1升级失败全记录-storage层崩溃.md": {
    status: "superseded",
    supersedes: "2026-10-18-DSH0.2.1rc2-val2跑通与三根因.md",
    reason: "正文第 3 行：结论作废，根因锁定 storage 层是误判；保留作排查过程",
  },
  "2026-10-17-cost-meter对WorkBuddy的记账缺口.md": {
    status: "superseded",
    supersedes: "2026-10-22-WorkBuddy积分额度条显示失败根治.md",
    reason: "正文第 1 行：方案 1 已过时（1.8.11 写完整 URL 会随端口漂移复发）；另两个缺口仍有参考价值",
  },
  "2026-10-17-记忆注入机制-双轨制.md": {
    status: "corrected",
    reason: "正文第 1 行：第三节结论过时（真正加载 persona 的是 cordis.patch.yml，非 .agent-presets）；更正内容在本文末尾第六节，无外部承接文档",
  },
};

const STATUSES = new Set(["active", "superseded", "obsolete", "corrected"]);

function readFm(file) {
  const text = readFileSync(file, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { fm: {}, body: text, hasFm: false, raw: m ? m[0] : null };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: text.slice(m[0].length), hasFm: true, raw: m[0] };
}

function buildFm(fields) {
  const order = ["status", "supersedes", "reason", "summary"];
  const lines = ["---"];
  for (const k of order) {
    if (fields[k]) lines.push(`${k}: ${fields[k]}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

// ── audit ────────────────────────────────────────────
function audit() {
  const files = readdirSync(FACT).filter(f => f.endsWith(".md"));
  let withStatus = 0, declaredStale = 0;
  const mismatch = [];

  // 只认「说自己的」作废声明。
  // 「X 的结论已作废」「之前那份是错的」是在说别人，不是在说本文。
  const selfStaleRe = new RegExp([
    String.raw`(本文|本文档|本篇|本记录)[^。\n]{0,20}(已过时|已作废|作废|已失效)`,
    String.raw`(结论作废|结论已作废)`,
    String.raw`请读新版`,
    String.raw`起作废`,          // 「2026-10-12 起作废」贴在本文开头
    String.raw`方案\s*1\s*已过时`,
  ].join("|"));

  // 说别人的句式：先剥掉，避免误判
  const mentionsOthersRe = /(之前|此前|前一份|那一份|旧版|旧文档|[`\w\-/]+\.md[^。\n]{0,10}(的)?结论)[^。\n]{0,30}(已?作废|已?过时|是错的|是误判)/g;

  for (const f of files) {
    const p = join(FACT, f);
    const { fm, body } = readFm(p);
    const st = fm.status ?? "active";
    if (fm.status) withStatus++;

    // 只看正文前 2000 字，且先剥掉"说别人"的句子
    const head = body.slice(0, 2000).replace(mentionsOthersRe, "");
    const declaresStale = selfStaleRe.test(head);
    if (declaresStale) declaredStale++;
    if (declaresStale && st === "active") mismatch.push(f);
  }

  console.log("kb-status --audit");
  console.log(`  事实库 ${files.length} 条`);
  console.log(`  已标 status: ${withStatus} 条`);
  console.log(`  正文声明自己过时/作废: ${declaredStale} 条`);
  console.log(`  ❌ 声明了却没标 status: ${mismatch.length} 条`);
  for (const m of mismatch) console.log(`    ✗ ${m}`);
  console.log("");
  const listed = Object.keys(STATE_MAP).length;
  console.log(`  待回填（STATE_MAP）: ${listed} 条`);
  for (const [f, s] of Object.entries(STATE_MAP)) {
    const exists = existsSync(join(FACT, f));
    console.log(`    ${exists ? "✓" : "✗ 文件不存在"} ${f} → ${s.status}`);
  }
  return mismatch.length === 0;
}

// ── apply ────────────────────────────────────────────
function apply() {
  let changed = 0, skipped = 0, failed = 0;
  for (const [fname, spec] of Object.entries(STATE_MAP)) {
    const p = join(FACT, fname);
    if (!existsSync(p)) { console.log(`✗ 跳过（文件不存在）: ${fname}`); failed++; continue; }
    const { fm, body, hasFm } = readFm(p);
    if (fm.status === spec.status && (!spec.supersedes || fm.supersedes === spec.supersedes)) {
      skipped++;
      continue;
    }
    const merged = { ...fm, status: spec.status };
    if (spec.supersedes) merged.supersedes = spec.supersedes;
    if (spec.reason) merged.reason = spec.reason;
    const out = buildFm(merged) + body;
    writeFileSync(p, out, { encoding: "utf8" });
    console.log(`✓ ${fname} → ${spec.status}${spec.supersedes ? " (取代 " + spec.supersedes + ")" : ""}`);
    changed++;
  }
  console.log("");
  console.log(`回填 ${changed} 条 / 已有正确状态 ${skipped} 条 / 失败 ${failed} 条`);
}

// ── check ────────────────────────────────────────────
function check() {
  const files = readdirSync(FACT).filter(f => f.endsWith(".md"));
  const problems = [];
  let active = 0, sup = 0, obs = 0, cor = 0, none = 0;

  const allNames = new Set(files);

  for (const f of files) {
    const { fm } = readFm(join(FACT, f));
    if (!fm.status) { none++; continue; }
    if (!STATUSES.has(fm.status)) {
      problems.push(`${f}: 非法 status「${fm.status}」（只允许 active/superseded/obsolete/corrected）`);
      continue;
    }
    if (fm.status === "active") active++;
    if (fm.status === "superseded") sup++;
    if (fm.status === "obsolete") obs++;
    if (fm.status === "corrected") cor++;

    if (fm.supersedes) {
      const target = fm.supersedes.replace(/\\/g, "/").replace(/^事实\//, "");
      if (!allNames.has(target)) {
        problems.push(`${f}: supersedes 指向不存在的文件「${fm.supersedes}」`);
      }
      if (target === f) {
        problems.push(`${f}: supersedes 指向自己`);
      }
    }
    // superseded 必须说得出被谁取代；corrected 不需要（更正就在本文里）
    if (fm.status === "superseded" && !fm.supersedes) {
      problems.push(`${f}: superseded 但没写 supersedes（说不出被谁取代）——若更正就在本文内，应标 corrected`);
    }
    if (fm.status === "corrected" && fm.supersedes) {
      problems.push(`${f}: corrected 不该有 supersedes（更正在本文件内）`);
    }
    if ((fm.status === "obsolete" || fm.status === "corrected") && !fm.reason) {
      problems.push(`${f}: ${fm.status} 必须写 reason（凭什么判的）`);
    }
  }

  console.log("kb-status --check");
  console.log(`  active      ${active}`);
  console.log(`  superseded  ${sup}`);
  console.log(`  obsolete    ${obs}`);
  console.log(`  corrected   ${cor}`);
  console.log(`  未标（等价 active） ${none}`);
  console.log(`  问题 ${problems.length} 条`);
  for (const p of problems) console.log(`    ✗ ${p}`);
  console.log("");
  console.log(problems.length === 0 ? "判定：PASS" : "判定：FAIL");
  return problems.length === 0;
}

// ── main ────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes("--apply")) { apply(); process.exit(0); }
if (argv.includes("--check")) { process.exit(check() ? 0 : 1); }
// 默认 --audit：诊断模式，发现问题也返回 0（它是报告工具，不是门）
audit();
process.exit(0);
