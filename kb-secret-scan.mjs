// 全库明文凭据扫描（字节级，解码固定，避免 Get-Content -Raw 的编码猜测）
import fs from "node:fs";
import path from "node:path";

const KB = "G:/path/to/knowledge-base";
const EXTS = new Set([".json", ".txt", ".log", ".jsonl", ".md", ".js", ".mjs", ".cjs", ".ps1", ".yml", ".yaml", ".html", ".csv", ".bib"]);

// 拆成独立 pattern，逐个报，避免交替项互相干扰
const PATTERNS = [
  { name: "ima token",      re: /"token"\s*:\s*"[A-Za-z0-9+/=]{30,}"/g },
  { name: "sk- key",        re: /sk-[A-Za-z0-9]{20,}/g },
  { name: "github token",   re: /gh[pous]_[A-Za-z0-9]{20,}/g },
  { name: "github pat",     re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "aws key",        re: /AKIA[0-9A-Z]{16}/g },
  { name: "private key",    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "明文password",    re: /(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"',]{6,}/gi },
];

function* walk(dir, depth = 0) {
  if (depth > 8) return;
  let es;
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "归档" || e.name === "node_modules" || e.name === ".git") continue;
      yield* walk(p, depth + 1);
    } else if (e.isFile()) {
      yield p;
    }
  }
}

function decode(buf) {
  // 严格 UTF-8，失败退 GBK
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder("gbk").decode(buf); } catch { return buf.toString("latin1"); }
  }
}

const findings = [];
let scanned = 0;

for (const f of walk(KB)) {
  // 跳过扫描器自身（它的白名单里含有会被误判的字面量）
  if (path.basename(f) === "kb-secret-scan.mjs") continue;
  const ext = path.extname(f).toLowerCase();
  if (!EXTS.has(ext)) continue;
  let st;
  try { st = fs.statSync(f); } catch { continue; }
  if (st.size > 10 * 1024 * 1024) continue;

  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  const text = decode(buf);
  scanned++;

  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    const ms = [...text.matchAll(re)];
    if (ms.length === 0) continue;
    // 排除已知的脱敏占位与文档示例
    const real = ms.filter(m => {
      const s = m[0];
      if (/\*\*\*REDACTED\*\*\*/.test(s)) return false;       // 已脱敏占位
      if (/xxxx|XXXX|your[-_]?key/i.test(s)) return false;    // 文档示例
      // 网页 JS 里的变量名/选择器，不是凭据（'password = _this_closest.find(' 之类）
      if (/password\s*=\s*_this|password\s*=\s*\$|password\s*=\s*document|password\s*=\s*this/i.test(s)) return false;
      if (/^password\s*[:=]\s*["']?[a-z_$][\w$.]*\(/i.test(s)) return false;
      // JS 对象字面量 {password: password} / {password: "password"} —— 键值同名，不是真凭据
      if (/^password\s*:\s*["']?password["']?$/i.test(s.trim())) return false;
      return true;
    });
    if (real.length === 0) continue;
    findings.push({
      file: path.relative(KB, f).replace(/\\/g, "/"),
      kind: name,
      count: real.length,
      sample: real[0][0].slice(0, 50),
    });
  }
}

console.log(`扫描 ${scanned} 个文件\n`);
if (findings.length === 0) {
  console.log("✅ 未发现明文凭据");
  process.exit(0);
}
console.log(`⚠ 发现 ${findings.length} 处：\n`);
for (const f of findings) {
  console.log(`  [${f.kind}] ${f.file}`);
  console.log(`      ${f.count} 处  ${f.sample}`);
}
process.exit(1);
