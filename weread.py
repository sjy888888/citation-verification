# -*- coding: utf-8 -*-
"""weread.py —— 知识库 → 微信读书 的唯一入口

2026-11-14 重写。犬子提了两个问题，都出在这条链上：

    问题一：「上传的斯密到马克思、中国经济原论为啥没有封面？」
        → txt2epub.py 原本根本不生成封面，微信读书里是灰块。
          已给 txt2epub.py 加 --cover-pdf（用原书 PDF 首页做封面）。

    问题二：「优化一下知识库微信读书这个流程」
        → 原来上传脚本硬编码 G:/path/to/workspace/电脑管理/.work-ebook/，
          那个目录被归档进 _archive 后，整条链断了，书根本传不上去。
          现在脚本和登录态都在 知识库/工具/.weread/，路径相对化。

这条入口做的事（按顺序，每步都可单独跑）：

    python weread.py list                     # 看产出目录有哪些 epub
    python weread.py check  <epub>            # 检查 epub 完整性（封面/目录/正文）
    python weread.py build  <txt> [--cover-pdf p] [--toc j] [--title t] [--author a]
    python weread.py upload <epub> [<epub>...]  # 上传（只传给的这几本）
    python weread.py all    <txt> [参数同上]    # build + check + upload 一条龙

★ 上传永远只传「明确指定」的文件。不扫描目录、不猜。

失败判据（都不靠"看起来成功"）：
    · build   → epub 文件必须存在且 > 50KB，否则报错
    · check   → 必须有 cover.jpg、nav.xhtml 有目录项、正文 > 1 万字符
    · upload  → 解析上传脚本输出的 before/after count，差值为 0 就是失败
"""
import argparse
import json
import os
import re
import subprocess
import sys
import io
import zipfile
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

TOOLS = Path(r"G:\path\to\knowledge-base\工具")
OUTDIR = Path(r"G:\path\to\knowledge-base\产出")
WEREAD_DIR = TOOLS / ".weread"
UPLOAD_MJS = WEREAD_DIR / "pw-upload-many.mjs"
INBOX = WEREAD_DIR / "in"


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", **kw)


# ---------------- check ----------------

def check_epub(path):
    """返回 (ok, [问题列表], 统计信息)"""
    p = Path(path)
    problems = []
    info = {}
    if not p.exists():
        return False, [f"文件不存在: {p}"], info
    if p.stat().st_size < 50 * 1024:
        problems.append(f"文件过小（{p.stat().st_size//1024} KB < 50 KB），可能是空壳")

    try:
        z = zipfile.ZipFile(p)
    except Exception as e:
        return False, [f"不是合法 zip/epub: {e}"], info

    names = z.namelist()
    info["文件数"] = len(names)

    # 封面
    covers = [n for n in names if "cover" in n.lower() and n.lower().endswith((".jpg", ".jpeg", ".png"))]
    if covers:
        info["封面"] = f"{covers[0]} ({z.getinfo(covers[0]).file_size//1024} KB)"
    else:
        problems.append("没有封面图（微信读书里显示为灰块）")

    # 目录
    nav = next((n for n in names if n.endswith("nav.xhtml")), None)
    if nav:
        h = z.read(nav).decode("utf-8", "replace")
        n_li = h.count("<li>")
        info["目录项"] = n_li
        if n_li == 0:
            problems.append("nav.xhtml 里没有任何目录项（翻不动）")
    else:
        problems.append("没有 nav.xhtml")

    # 正文
    chaps = [n for n in names if re.search(r"chap\d+\.xhtml$", n)]
    total = 0
    for n in chaps:
        total += len(re.sub(r"<[^>]+>", "", z.read(n).decode("utf-8", "replace")))
    info["章节数"] = len(chaps)
    info["正文字符"] = total
    if total < 10000:
        problems.append(f"正文只有 {total:,} 字符，可能抽取失败")

    # opf 封面声明
    opf = next((n for n in names if n.endswith("content.opf")), None)
    if opf:
        o = z.read(opf).decode("utf-8", "replace")
        if "cover-image" not in o:
            problems.append("content.opf 没声明 cover-image 属性")
        if 'name="cover"' not in o:
            problems.append("content.opf 缺 <meta name=\"cover\">（部分阅读器靠这个认封面）")

    return len(problems) == 0, problems, info


def cmd_check(path):
    ok, problems, info = check_epub(path)
    print(f"=== {Path(path).name} ===")
    for k, v in info.items():
        print(f"   {k}: {v}")
    if ok:
        print("   ✅ 通过")
    else:
        print("   ❌ 有问题：")
        for x in problems:
            print(f"      - {x}")
    return ok


# ---------------- build ----------------

def cmd_build(args):
    out = OUTDIR / (args.out or (Path(args.txt).stem + ".epub"))
    cmd = [sys.executable, str(TOOLS / "txt2epub.py"), args.txt, str(out)]
    if args.title:
        cmd += ["--title", args.title]
    if args.author:
        cmd += ["--author", args.author]
    if args.toc:
        cmd += ["--toc", args.toc]
    if args.cover_pdf:
        cmd += ["--cover-pdf", args.cover_pdf, "--cover-page", str(args.cover_page)]

    r = run(cmd)
    tail = [x for x in (r.stdout or "").splitlines() if x.strip()][-4:]
    for x in tail:
        print("   " + x[:110])

    if not out.exists() or out.stat().st_size < 50 * 1024:
        print(f"   ❌ 构建失败（文件不存在或过小）")
        if r.stderr:
            print("   " + (r.stderr or "")[-300:])
        return None
    print(f"   ✅ 已生成 {out.name}  {out.stat().st_size//1024} KB")
    return str(out)


# ---------------- upload ----------------

def cmd_upload(paths):
    files = [str(Path(x).resolve()) for x in paths]
    missing = [f for f in files if not Path(f).exists()]
    if missing:
        print("   ❌ 以下文件不存在，不上传：")
        for m in missing:
            print(f"      {m}")
        return False
    if not UPLOAD_MJS.exists():
        print(f"   ❌ 上传脚本不在: {UPLOAD_MJS}")
        return False

    INBOX.mkdir(parents=True, exist_ok=True)
    lst = INBOX / f"upload_{__import__('time').strftime('%H%M%S')}.json"
    lst.write_text(json.dumps(files, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"   上传 {len(files)} 个文件：")
    for f in files:
        print(f"      {Path(f).name}")

    env = dict(os.environ, WEREAD_WAIT_MIN="8", PYTHONIOENCODING="utf-8")
    r = run(["node", str(UPLOAD_MJS), str(lst)], env=env, timeout=900)
    out = (r.stdout or "") + (r.stderr or "")

    # 2026-11-14 修：原来按行匹配，subprocess 捕获后行可能粘连导致抓不到。
    # 改成对全文做正则，两种写法都认。
    before = after = None
    m = re.search(r"before\s*count\s*=\s*(\d+)", out)
    if m: before = int(m.group(1))
    m = re.search(r"after\s*count\s*=\s*(\d+)", out)
    if m: after = int(m.group(1))
    # 兜底：从「已导入 N 本」里读
    if after is None:
        m = re.search(r"已导入\s*(\d+)\s*本", out)
        if m: after = int(m.group(1))
    if before is None:
        m = re.search(r"已导入\s*(\d+)\s*本", out)
        if m and after is not None and after >= 0: before = after
    for line in out.splitlines():
        if "[upload]" in line or "导入完成" in line or "LOGIN" in line:
            print("   " + line.strip()[:160])

    if before is not None and after is not None:
        delta = after - before
        print(f"\n   before={before}  after={after}  差值={delta}")
        if delta >= len(files):
            print(f"   ✅ 上传成功（{delta} 本）")
            return True
        elif delta > 0:
            print(f"   ⚠ 只传上去 {delta} / {len(files)} 本")
            return False
        else:
            print(f"   ❌ 一本都没传上去")
            return False
    print("   ⚠ 没能解析出 before/after count，结果未知。看截图：", WEREAD_DIR / "shots")
    return False


# ---------------- main ----------------

def main():
    ap = argparse.ArgumentParser(description="知识库 → 微信读书")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("list", help="列出产出目录的 epub")
    s = sub.add_parser("check", help="检查 epub 完整性")
    s.add_argument("epub")

    s = sub.add_parser("build", help="txt → epub")
    s.add_argument("txt")
    s.add_argument("--out", default=None)
    s.add_argument("--title", default=None)
    s.add_argument("--author", default="")
    s.add_argument("--toc", default=None)
    s.add_argument("--cover-pdf", default=None)
    s.add_argument("--cover-page", type=int, default=1)

    s = sub.add_parser("upload", help="上传 epub 到微信读书")
    s.add_argument("epubs", nargs="+")

    s = sub.add_parser("all", help="build + check + upload")
    s.add_argument("txt")
    s.add_argument("--out", default=None)
    s.add_argument("--title", default=None)
    s.add_argument("--author", default="")
    s.add_argument("--toc", default=None)
    s.add_argument("--cover-pdf", default=None)
    s.add_argument("--cover-page", type=int, default=1)

    args = ap.parse_args()

    if args.cmd == "list":
        eps = sorted(OUTDIR.glob("*.epub"), key=lambda x: -x.stat().st_mtime)
        print(f"产出目录 {len(eps)} 个 epub：")
        for e in eps[:30]:
            z_ok = "?"
            try:
                zz = zipfile.ZipFile(e)
                z_ok = "✅封" if any("cover" in n.lower() for n in zz.namelist()) else "❌无封"
            except Exception:
                z_ok = "损坏"
            print(f"   {e.stat().st_size//1024:>6} KB  {z_ok}  {e.name[:56]}")

    elif args.cmd == "check":
        sys.exit(0 if cmd_check(args.epub) else 1)

    elif args.cmd == "build":
        ok = cmd_build(args)
        sys.exit(0 if ok else 1)

    elif args.cmd == "upload":
        sys.exit(0 if cmd_upload(args.epubs) else 1)

    elif args.cmd == "all":
        out = cmd_build(args)
        if not out:
            sys.exit(1)
        if not cmd_check(out):
            print("   ⚠ 检查未通过，仍继续上传（自己判断）")
        ok = cmd_upload([out])
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
