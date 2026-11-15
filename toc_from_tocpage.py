# -*- coding: utf-8 -*-
"""toc_from_tocpage.py —— 从书的「目录页」建立 EPUB 目录

2026-11-12 起因（唐正东《从斯密到马克思》）：
    这本 PDF 只有 1 条书签（"正文"），转出来的 epub 只有 1 章，翻不动。
    但正文 L335-L420 有完整的目录页，5 章 47 节。

    目录页的实际格式（OCR 后）：
        '第一章古典历史主义的经济哲学方法'              ← 章名，**行尾没页码**
        '一亚当·斯密及苏格兰历史学派17'                 ← 节名 + 页码紧贴
        '第二章李嘉图及李嘉图派社会主义者的经济哲学方法....98'  ← 章名 + 省略号 + 页码
        '第三章李斯特及德国历史学派的经济哲学方法183'      ← 章名 + 页码紧贴

    三种格式混在一起，所以第一版正则只认出 3/5 章。

判据（逐条都在实测里对过）：
    ① 先在正文里找「目次/目录」标记，目录页从那里起
    ② 章标题：「第X章」开头，取到该行末尾的连续数字作页码
       如果行尾没数字，就用**下一行**里第一个数字（那是第一章的情况：
       第一章下面紧跟「一亚当·斯密及苏格兰历史学派17」，
       但 17 是第一节的页码，不是章的 —— 所以此时取「下一行页码 - 1」不可靠，
       直接放弃页码，改用「正文里第一次出现该章名」的行定位）
    ③ 有三种定位法，按可靠性排序：
       a) 目录页给了印刷页码 → 找正文里【pN】==该页码
       b) 章名本身在正文里独立成行 → 直接用那一行
       c) 都没有 → 用「下一章位置 - 1」兜底

用法：
    python toc_from_tocpage.py --book "唐正东-从斯密到马克思" --apply
"""
import argparse
import json
import re
import sys
import io
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

BASE = Path(r"G:\path\to\knowledge-base\学科资料")
OUT = Path(r"G:\path\to\knowledge-base\索引")

TOC_HEAD = re.compile(r"^(目\s*[次录]|目\s*录)$")
CH = re.compile(r"^第\s*([一二三四五六七八九十]+)\s*章\s*(.*)$")
PDFMARK = re.compile(r"\[PDFp(\d+)\]$")
PRINTED = re.compile(r"^【p(\d+)】")
TAILNUM = re.compile(r"(\d{1,4})\s*$")


def clean(s):
    """去掉省略号、点号、页码，只留标题。"""
    s = re.sub(r"[.．·…]{2,}.*$", "", s)
    s = re.sub(r"\s*\d{1,4}\s*$", "", s)
    s = re.sub(r"[*＊·※]", "", s)
    return s.strip(" .．·\t\u3000")


def norm(s):
    """归一化：只留汉字和字母，用于在正文里匹配同一章名。"""
    return re.sub(r"[^\u4e00-\u9fffA-Za-z]", "", s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--toc-window", type=int, default=130,
                    help="目录页最多多少行")
    args = ap.parse_args()

    files = [f for f in BASE.rglob("*.txt") if args.book in f.name and not f.name.startswith("_")]
    if not files:
        print(f"没找到含「{args.book}」的文件")
        return
    f = files[0]
    lines = f.read_text(encoding="utf-8", errors="replace").split("\n")
    print(f"文件：{f.name}  {len(lines):,} 行")

    # ① 找目录页
    #   2026-11-12 修：唐正东这本 OCR 把「目录」切成了「录」（L329），
    #   TOC_HEAD 认不出。于是加第二条路：找「第X章」标题最密集的一段，
    #   那一段就是目录页（正文里的章标题是散落的，目录页是连续 5 章挤在一起）。
    ti = None
    for i, l in enumerate(lines):
        if TOC_HEAD.match(l.strip()) or l.strip() in ("录", "目"):
            ti = i
            break
    if ti is None:
        ch_pos = [i for i, l in enumerate(lines) if CH.match(l.strip())]
        if len(ch_pos) >= 3:
            # 找连续 3 个章标题跨度 < 120 行的一段
            for k in range(len(ch_pos) - 2):
                if ch_pos[k+2] - ch_pos[k] < 120:
                    ti = ch_pos[k]
                    print(f"没找到目录标记，用章标题聚集推定目录页起于 L{ti+1}")
                    break
    if ti is None:
        print("认不出目录页，退出")
        return
    print(f"目录页起于 L{ti+1}")

    # ② 提取章名 + 候选页码
    chaps = []
    for j in range(ti + 1, min(len(lines), ti + args.toc_window)):
        s = lines[j].strip()
        if not s:
            continue
        m = CH.match(s)
        if not m:
            continue
        title = clean(m.group(2))
        if len(norm(title)) < 3:
            continue
        # 行尾页码
        pg = None
        tm = TAILNUM.search(s)
        if tm:
            pg = int(tm.group(1))
            # 排除「章名里本身带数字」的误判
            if pg > 900:
                pg = None
        chaps.append({"num": m.group(1), "name": f"第{m.group(1)}章 {title}",
                      "printed": pg, "toc_line": j + 1})

    print(f"\n目录页里 {len(chaps)} 章：")
    for c in chaps:
        print(f"   {c['name'][:44]:<46} 目录页页码={c['printed']}")

    # ③ 定位到正文 PDF 页
    printed_idx, pdf_idx = {}, {}
    for i, l in enumerate(lines):
        s = l.strip()
        mm = PRINTED.match(s)
        if mm:
            printed_idx.setdefault(int(mm.group(1)), i)
        pm = PDFMARK.search(s)
        if pm:
            pdf_idx.setdefault(i, int(pm.group(1)))

    def pdfpage_of(line_idx):
        for k in range(line_idx, -1, -1):
            pm = PDFMARK.search(lines[k].strip())
            if pm:
                return int(pm.group(1))
        return None

    # 正文里章名独立成行的位置
    #   2026-11-12：**用章号匹配，不用全名匹配**。
    #   实测正文里标题是「第一章古典历史主义的」（被 OCR 截断），
    #   目录页是「第一章 古典历史主义的经济哲学方法」，全名对不上，
    #   结果 body_hits 全空，落到兜底「下一章位置-1」，两章只差 1 页。
    #   章号（第一章/第二章）是稳的，用它匹配。
    body_hits = {}
    for i, l in enumerate(lines):
        if i <= ti + args.toc_window:
            continue
        m = CH.match(l.strip())
        if not m:
            continue
        num = m.group(1)
        if num in body_hits:
            continue
        # 排除「第一章中就专门对…」这种正文句（长度 > 30 的当正文）
        if len(l.strip()) > 30:
            continue
        body_hits[num] = i

    for c in chaps:
        pos = None
        # 2026-11-12 调序：**章名匹配正文优先于印刷页码**。
        #   原顺序是「印刷页码优先」，但唐正东这本目录页页码常常抓不到，
        #   落到兜底「下一章位置-1」，结果第一章和第二章只差 1 页（PDFp123/124），
        #   明显错误。正文里章名独立成行是更可靠的位置。
        # b) 章名在正文独立成行（最可靠）
        if c["num"] in body_hits:
            pos = body_hits[c["num"]]
        # a) 目录页给了印刷页码
        if pos is None and c["printed"] and c["printed"] in printed_idx:
            pos = printed_idx[c["printed"]]
        c["pos"] = pos

    # c) 兜底：用下一章位置 - 1
    for k, c in enumerate(chaps):
        if c["pos"] is not None:
            continue
        nxt = next((x["pos"] for x in chaps[k+1:] if x["pos"] is not None), None)
        c["pos"] = (nxt - 1) if nxt and nxt > 0 else None

    found = [c for c in chaps if c["pos"] is not None]
    print(f"\n定位到 {len(found)}/{len(chaps)} 章：")
    items = []
    for c in found:
        pp = pdfpage_of(c["pos"])
        if pp is None:
            continue
        items.append({"name": c["name"], "start": pp, "end": pp})
        print(f"   PDFp{pp:<5} {c['name'][:46]}")

    if args.dry or not args.apply:
        print("\n（未写入，加 --apply 才改）")
        return

    outp = OUT / f"_tmp-{args.book}-toc.json"
    outp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n已写 {outp}")


if __name__ == "__main__":
    main()
