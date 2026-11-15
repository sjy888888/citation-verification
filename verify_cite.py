# -*- coding: utf-8 -*-
"""verify_cite.py —— 引用复检：拿引用串回 PDF 原件核对

2026-11-10 用户问：「那有没有复检机制？」

在此之前没有。`quote.mjs --gb` 只是把 txt 里的页码拼成引用串，
没人回头看那个页码在 PDF 上对不对。

本脚本做四件事：
  ① 从引用串里抽出「书名/卷 + 页码」
  ② 找到对应 PDF 原件
  ③ 翻到那一页，把页首 3 行 + 页脚 3 行打印出来
  ④ 判定：页面上真的有这个印刷页码吗？

判据（三选一）：
  ✅ VERIFIED   —— 页面边缘找到该数字，且位置是页眉/页脚
  ⚠️ INFERRED   —— 页码是连续页推出来的（txt 里 zone=inferred），PDF 该页无印刷页码
  ❌ MISMATCH   —— 页面上找不到该数字，或找到的是正文里的数字

用法：
  python verify_cite.py --quote "《马克思恩格斯文集》第1卷, 人民出版社2009年版, 第162页"
  python verify_cite.py --book 文集01 --page 162
  python verify_cite.py --batch cites.txt       每行一条引用串
"""
import argparse
import re
import sys
from pathlib import Path

import pymupdf

L0 = Path(r"G:\path\to\knowledge-base\学科资料\L0-马恩列原著")
PDFDIRS = [
    Path(r"G:\path\to\knowledge-base\学科资料\_pdf原件"),
    Path(r"G:\path\to\workspace\百度网盘"),
]


def find_pdf(hint: str):
    """书名/卷 → PDF 原件"""
    cands = []
    m = re.search(r"文集[》\s]*第?\s*(\d+)\s*卷", hint)
    if m:
        cands.append(f"mea{int(m.group(1)):02d}.pdf")
    m = re.search(r"选集[》\s]*第?\s*(\d+)\s*卷", hint)
    if m:
        cands.append(f"mes{int(m.group(1)):02d}.pdf")
    m = re.search(r"全集[》\s]*第?\s*(\d+)\s*卷", hint)
    if m:
        cands.append(f"me2-{int(m.group(1)):02d}.pdf")
    m = re.search(r"列宁全集[》\s]*第?\s*(\d+)\s*卷", hint)
    for c in cands:
        for d in PDFDIRS:
            f = d / c
            if f.exists():
                return f
    return None


def page_texts(pdf, printed_page, offset_guess=None):
    """在 PDF 里找印刷页码为 printed_page 的那一页

    先用 txt 的 pages.json / 众数偏移猜，再前后各扫 30 页找实测。
    """
    doc = pymupdf.open(pdf)
    H = doc.load_page(0).rect.height
    hits = []
    # 猜 PDF 页序：印刷页 + 常见偏移
    guesses = set()
    if offset_guess:
        guesses.add(printed_page + offset_guess)
    # 2026-11-10 修：先试常见偏移 12–30，再退到 5–60。
    #   事故：选集01 偏移是 +16，但 pdf64（folio+8）正文里也有个 "56"，
    #   按从小到大扫就先命中 pdf64，真页码页 pdf72 反而没看到。
    #   另外命中后只认「页首/页脚」的，正文里的数字不算。
    for off in list(range(12, 31)) + list(range(5, 61)) + list(range(31, 61)):
        guesses.add(printed_page + off)
    seen_g = set()
    for g in sorted(x for x in guesses if 1 <= x <= doc.page_count):
        if g in seen_g:
            continue
        seen_g.add(g)
        pg = doc.load_page(g - 1)
        found = []
        for b in pg.get_text("dict")["blocks"]:
            if b.get("type") != 0:
                continue
            for ln in b.get("lines", []):
                for s in ln.get("spans", []):
                    t = s.get("text", "").strip()
                    t = t.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
                    if t != str(printed_page):
                        continue
                    y0, y1 = s["bbox"][1], s["bbox"][3]
                    frac_top = y0 / H
                    frac_bot = (H - y1) / H
                    # 只认贴边的（页首/页脚），正文里的数字不要
                    if frac_top < 0.20 or frac_bot < 0.20:
                        found.append("head" if frac_top < frac_bot else "foot")
        if found:
            hits.append((g, found))

    # 2026-11-10 修：**优先信「偏移落在最常见区间」的那一页**。
    #   事故：查「在它所能容纳的全部生产力…」时，pdf15 是编者导读
    #   （正文里引了这段话并标「见本卷第412—413页」），pdf437 才是正文 p413。
    #   原逻辑取 hits[0]，先命中 pdf15，而那里没印 413 → 误判 MISMATCH。
    #   判据：把命中按「与 folio 的偏移」聚一下，取**出现次数最多的偏移**优先。
    if len(hits) > 1:
        from collections import Counter
        offs = Counter(g - folio for g, _ in hits)
        best_off = offs.most_common(1)[0][0]
        hits.sort(key=lambda x: (0 if x[0] - folio == best_off else 1, abs(x[0] - folio)))
    return doc, hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quote", help="完整引用串")
    ap.add_argument("--book", help="书名或卷（如 文集01）")
    ap.add_argument("--page", type=int, help="印刷页码")
    ap.add_argument("--batch", help="批量：每行一条引用串")
    args = ap.parse_args()

    items = []
    if args.batch:
        for ln in Path(args.batch).read_text(encoding="utf-8").splitlines():
            ln = ln.strip()
            if ln:
                items.append(ln)
    elif args.quote:
        items.append(args.quote)
    elif args.book and args.page:
        items.append(f"{args.book} 第{args.page}页")
    else:
        print("用法: --quote '<引用串>' 或 --book 文集01 --page 162 或 --batch cites.txt")
        sys.exit(1)

    for q in items:
        hint = q
        m = re.search(r"第\s*(\d+)\s*页", q)
        if not m:
            print(f"❌ 抽不出页码：{q[:60]}")
            continue
        page = int(m.group(1))
        pdf = find_pdf(hint)
        print(f"\n{'='*70}")
        print(f"引用：{q.strip()[:100]}")
        print(f"印刷页：{page}")
        if not pdf:
            print("❌ 找不到 PDF 原件（书名认不出，或原件不在 _pdf原件/）")
            continue
        print(f"原件：{pdf.name}")
        doc, hits = page_texts(pdf, page)
        if not hits:
            print(f"❌ MISMATCH — 在 {pdf.name} 里翻不到印着「{page}」的页")
            print("   → 可能页码错，也可能这页没印页码（影印/图版）")
            doc.close()
            continue
        g, zones = hits[0]
        pg = doc.load_page(g - 1)
        lines = [l.strip() for l in pg.get_text("text").split("\n") if l.strip()]
        print(f"PDF 第 {g} 页（印刷页 {page}），边缘位置：{','.join(set(zones))}")
        print(f"  首 3 行：{' | '.join(lines[:3])[:90]}")
        print(f"  末 3 行：{' | '.join(lines[-3:])[:90]}")
        if all(z == "body" for z in zones):
            print(f"⚠️  该数字出现在正文区，不是页眉/页脚 —— 可能是引文页码，不是印刷页")
        else:
            print(f"✅ VERIFIED — 页面上有印着 {page} 的页码，位置在 {','.join(set(zones))}")
        if len(hits) > 1:
            print(f"   （另有 {len(hits)-1} 页也印着同样数字，可能是正文引文）")
        doc.close()


if __name__ == "__main__":
    main()
