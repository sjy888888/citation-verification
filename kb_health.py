# -*- coding: utf-8 -*-
"""kb_health.py —— 全库体检

2026-11-11 起因（犬子「顺带优化一下原著库」）：
    第一遍我只查了页码和篇目，说「原著库不用大改」。
    第二遍补查重复，查出 4 组重复 + 2 个空文件。
    → 「不用大改」不等于「不用查」。

这份工具把体检固化下来。以后跑完一批入库，一条命令查全库。

查五件事：
    ① 内容重复（同正文不同名 / 同内容不同层）
    ② 空文件（0 字节）
    ③ 极短文件（<1,000 字，可能是失败产物）
    ④ 页码异常（有页标记但页码率 <50%）
    ⑤ 层间同名（同名文件出现在两个层，可能串了）

用法：
    python kb_health.py                    # 全部检查，只报问题
    python kb_health.py --layer L0-马恩列原著
    python kb_health.py --dups-only        # 只查重复
"""
import argparse
import hashlib
import re
import sys
from collections import defaultdict
from pathlib import Path

BASE = Path(r"G:\path\to\knowledge-base\学科资料")
MARK_P = re.compile(r"【p\d+】")
MARK_ANY = re.compile(r"\[PDFp\d+\]")


def walk(layer=None):
    root = BASE / layer if layer else BASE
    for f in root.rglob("*.txt"):
        rel = f.relative_to(BASE)
        if any(x.startswith("_") for x in rel.parts if x):
            continue
        yield f, rel


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--layer", default=None)
    ap.add_argument("--dups-only", action="store_true")
    ap.add_argument("--min-chars", type=int, default=1000)
    args = ap.parse_args()

    files = list(walk(args.layer))
    print(f"体检范围：{len(files)} 个文件"
          + (f"（限 {args.layer}）" if args.layer else "") + "\n")

    problems = 0

    # ① 内容重复
    sig = defaultdict(list)
    named = defaultdict(list)
    for f, rel in files:
        try:
            t = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        named[f.name].append(str(rel))
        # 用正文（跳过文件头）前 20 万字做指纹
        body = t.split("=" * 70, 2)[-1][:200000]
        h = hashlib.md5(re.sub(r"\s+", "", body).encode()).hexdigest()[:12]
        sig[h].append((str(rel), len(t)))

    dups = {h: v for h, v in sig.items() if len(v) > 1}
    if dups:
        problems += len(dups)
        print(f"① 内容重复：{len(dups)} 组")
        for h, v in dups.items():
            print(f"   ── {len(v)} 份相同 ──")
            for rel, n in v:
                print(f"      {n/10000:>7.1f} 万字  {rel[:70]}")
        print()

    if args.dups_only:
        print(f"问题合计 {problems} 组")
        return

    # ② 空文件  ③ 极短文件
    empty, tiny = [], []
    ratio_bad = []
    for f, rel in files:
        sz = f.stat().st_size
        if sz == 0:
            empty.append(str(rel))
            continue
        t = f.read_text(encoding="utf-8", errors="replace")
        if len(t) < args.min_chars:
            tiny.append((len(t), str(rel)))
        p_ok = len(MARK_P.findall(t))
        pages = len(MARK_ANY.findall(t))
        if pages >= 20 and p_ok / pages < 0.5:
            ratio_bad.append((p_ok / pages, pages, str(rel)))

    if empty:
        problems += len(empty)
        print(f"② 空文件：{len(empty)} 个")
        for r in empty:
            print(f"      {r}")
        print()

    if tiny:
        print(f"③ 极短文件（<{args.min_chars} 字）：{len(tiny)} 个")
        for n, r in sorted(tiny)[:10]:
            print(f"      {n:>6} 字  {r[:70]}")
        print()

    if ratio_bad:
        print(f"④ 页码率 <50%（≥20 页的书）：{len(ratio_bad)} 本")
        for r, pg, rel in sorted(ratio_bad)[:10]:
            print(f"      {r:>4.0%}  {pg:>4} 页  {rel[:66]}")
        print()

    # ⑥ EPUB 转换件的「只有目录没有正文」检查
    #
    #   2026-11-11 起因：查《存在与时间》时，我只看文件开头 600 字，
    #   看到「第一章…第二节…」就下结论「正文是目录」。
    #   实测：「此在」出现 2,949 次，首次 644 字、末次 340,005 字（全文 340,161），
    #   **正文是完整的**，只是 EPUB 前面本来就放目录。
    #
    #   教训：判断「有没有正文」不能看头部，要看**关键词在全文的分布**。
    #   判据：把全文分 10 段，看「长行（≥40字）」出现在几段里。
    #   只有目录的书，长行集中在 1-2 段；正常书分布 ≥6 段。
    epub_short = []
    for f, rel in files:
        try:
            t = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        if len(t) < 5000:
            continue
        # 只在像是 EPUB 转换（有「EPUB」字样）的文件上查
        if "EPUB" not in t[:2000]:
            continue
        seg = len(t) // 10
        if seg < 100:
            continue
        with_long = 0
        for k in range(10):
            part = t[k * seg:(k + 1) * seg]
            if any(len(l.strip()) >= 40 for l in part.split("\n")):
                with_long += 1
        if with_long <= 3:
            epub_short.append((with_long, len(t), str(rel)))

    if epub_short:
        print(f"⑥ EPUB 转换件疑似「只有目录」：{len(epub_short)} 个")
        for n, sz, rel in sorted(epub_short):
            print(f"      长行只在 {n}/10 段  {sz/10000:>6.1f} 万字  {rel[:60]}")
        print()

    # ⑤ 层间同名
    same = {n: v for n, v in named.items() if len(v) > 1}
    if same:
        print(f"⑤ 层间/目录同名：{len(same)} 组")
        for n, v in list(same.items())[:8]:
            layers = {x.split("/")[0] for x in v}
            if len(layers) > 1:
                print(f"      {n[:44]}  →  {sorted(layers)}")
        print()

    print(f"=== 问题合计 {problems} 组（含重复） ===")


if __name__ == "__main__":
    main()
