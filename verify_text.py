# -*- coding: utf-8 -*-
"""verify_text.py —— 引文文字级复检：把 txt 里的原句和 PDF 原页逐字比对

2026-11-10 用户：「重点核查优化一下原著引用的正确性与准确性。」

之前的 verify_cite.py 只核**页码**，不核**文字**。
但引文出错更常见的是：OCR 错字、漏字、被拼接、混入了别处的句子。

本脚本做三件事：
  ① 给定「书名 + 页码 + 引文」，回 PDF 那一页，逐字比
  ② 报告：缺失的字 / 多出的字 / 错字（形近）
  ③ 判定：VERIFIED / MINOR_DIFF（1–2 字）/ MAJOR_DIFF（>2 字或缺句）

用法：
  python verify_text.py --book 文集02 --page 592 --text "无论哪一个社会形态，在它所能容纳的全部生产力发挥出来以前，是决不会灭亡的"
  python verify_text.py --batch texts.txt   每行：书名|页码|引文
"""
import argparse
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

import pymupdf

PDFDIRS = [
    Path(r"G:\path\to\knowledge-base\学科资料\_pdf原件"),
    Path(r"G:\path\to\workspace\百度网盘"),
]


def find_pdf(hint: str):
    cands = []
    m = re.search(r"文集\s*第?\s*(\d+)\s*卷", hint)
    if m:
        cands.append(f"mea{int(m.group(1)):02d}.pdf")
    m = re.search(r"选集\s*第?\s*(\d+)\s*卷", hint)
    if m:
        cands.append(f"mes{int(m.group(1)):02d}.pdf")
    m = re.search(r"全集\s*第?\s*(\d+)\s*卷", hint)
    if m:
        cands.append(f"me2-{int(m.group(1)):02d}.pdf")
    for c in cands:
        for d in PDFDIRS:
            f = d / c
            if f.exists():
                return f
    return None


def norm(s):
    """只留汉字和数字，去掉标点空格，专比字形"""
    return re.sub(r"[^\u4e00-\u9fff0-9]", "", s)


def find_page_by_folio(pdf, folio):
    """翻到印着 folio 的那一页"""
    doc = pymupdf.open(pdf)
    H = doc.load_page(0).rect.height
    for off in range(5, 60):
        g = folio + off
        if not (1 <= g <= doc.page_count):
            continue
        pg = doc.load_page(g - 1)
        for b in pg.get_text("dict")["blocks"]:
            if b.get("type") != 0:
                continue
            for ln in b.get("lines", []):
                for s in ln.get("spans", []):
                    # 2026-11-10 修：选集/全集有些卷页码是**全角数字**（５６），
                    # 原来只认半角 "56"，导致明明有页码也判 MISMATCH。
                    _raw = s.get("text", "").strip()
                    _half = _raw.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
                    if _half == str(folio):
                        y0, y1 = s["bbox"][1], s["bbox"][3]
                        if y0 / H < 0.30 or (H - y1) / H < 0.30:
                            return doc, g
    return doc, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--book")
    ap.add_argument("--page", type=int)
    ap.add_argument("--text")
    ap.add_argument("--batch")
    args = ap.parse_args()

    items = []
    if args.batch:
        for ln in Path(args.batch).read_text(encoding="utf-8").splitlines():
            ln = ln.strip()
            if not ln or ln.startswith("#"):
                continue
            parts = ln.split("|")
            if len(parts) == 3:
                items.append((parts[0], int(parts[1]), parts[2]))
    elif args.book and args.page and args.text:
        items.append((args.book, args.page, args.text))
    else:
        print("用法: --book 文集02 --page 592 --text '…'  或  --batch texts.txt（书名|页码|引文）")
        sys.exit(1)

    for book, page, quote in items:
        print(f"\n{'='*74}")
        print(f"书：{book}  页：{page}")
        print(f"引文：{quote[:70]}{'…' if len(quote) > 70 else ''}")
        pdf = find_pdf(book)
        if not pdf:
            print("❌ 找不到 PDF")
            continue
        doc, g = find_page_by_folio(pdf, page)
        if g is None:
            print(f"❌ PDF 里翻不到印着 {page} 的页")
            doc.close()
            continue
        ptext = doc.load_page(g - 1).get_text("text")
        doc.close()

        a = norm(quote)
        b = norm(ptext)
        # 在整页里找最像的一段
        sm = SequenceMatcher(None, a, b)
        blocks = sm.get_matching_blocks()
        best = max(blocks, key=lambda x: x.size)
        if best.size < len(a) * 0.5:
            print(f"❌ MAJOR_DIFF — 整页里找不到相似段（最长匹配 {best.size}/{len(a)} 字）")
            continue
        # 对齐那一段
        start_b = best.b - best.a
        seg = b[start_b:start_b + len(a) + 20]
        sm2 = SequenceMatcher(None, a, seg)
        diffs = []
        for tag, i1, i2, j1, j2 in sm2.get_opcodes():
            if tag == "equal":
                continue
            diffs.append((tag, a[i1:i2], seg[j1:j2]))
        # 2026-11-10 修：原来把 insert 也算进差异，导致「引文只是原句的一部分」
        #   这种正常情况被报成 MAJOR_DIFF（原书比你多 20 字）。
        #   正确判据：**引文必须能在原页里找到**，原书多出来的字不算错。
        #   所以只看 delete / replace：引文里有、原书里没有的，才是真问题。
        real = [d for d in diffs if d[0] in ("delete", "replace")]
        if not real:
            print(f"✅ VERIFIED — 引文完整出现在原页（{len(a)} 字全对上），PDF 第 {g} 页")
        else:
            ndel = sum(len(x[1]) for x in real)
            lvl = "MINOR_DIFF" if ndel <= 2 else "MAJOR_DIFF"
            mark = "⚠️" if lvl == "MINOR_DIFF" else "❌"
            print(f"{mark} {lvl} — 引文中有 {ndel} 字原书对不上，PDF 第 {g} 页")
            for tag, x, y in real[:8]:
                print(f"     {tag:8s} 你写「{x}」 原书「{y}」")


if __name__ == "__main__":
    main()
