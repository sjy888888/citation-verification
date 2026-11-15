# -*- coding: utf-8 -*-
"""txt2epub.py —— 纯文本 → EPUB（微信读书友好）

2026-11-12 为什么不用 jsonl2epub5.py：
    那个工具依赖 PDF 书签 + 行坐标（y0/y1/x0/x1）来做分章和段落重建。
    我们的 OCR（ocr_pdf_paged.py）输出的是**纯文本行**，没有坐标。
    硬加伪坐标后能跑，但结果不对：
      · 书签是「中译本序/马克思主义和哲学/…」这种篇名，没有「第X章」
      · 4 章只写进 3 章，p3-p29 整段丢失
      · 20 个段落，全书 32 万字符只剩 9 万
    **坐标体系对不上，适配代价大于重写。**

这个工具的做法：
    ① 按页码标记（【pN】/【p?|pdfN】/[PDFpN]）切页
    ② 按「短行 + 前后空行」认章标题（可选，识别不到就整本一章）
    ③ 段落重建：中文按句末标点断段，不按行断
    ④ 生成标准 EPUB3，带 nav.xhtml 目录

微信读书适配（参考 weread-epub-fix 技能的坑）：
    · 目录必须在 nav.xhtml，不能只放 NCX
    · 不能有裸 & < > 字符
    · 注释/引文不插正文中间（本工具不做引文抽取，就不会有这问题）

用法：
    python txt2epub.py <in.txt> <out.epub> [--title 书名] [--author 作者]
"""
import argparse
import html
import re
import sys
import io
import uuid
import zipfile
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# 页标记：三种格式都认
PMARK = re.compile(r"^(?:【p(\d+)[※]?】|【p\?[^】]*】)?\[PDFp(\d+)\]$")
# 句末标点
SENT_END = "。！？…」；：，"
# 章标题候选：短行、不含句末标点、前后有空行
CHAP = re.compile(r"^第\s*[0-9一二三四五六七八九十百千万]+\s*[篇章卷节]")
# 文件头（====包裹的那段）要跳过
HEADER_SEP = "=" * 60


def read_pages(path):
    """切成 [(页码标签, [行...])]。"""
    raw = Path(path).read_text(encoding="utf-8", errors="replace")
    lines = raw.split("\n")
    # 跳过文件头
    if lines and lines[0].startswith("="):
        try:
            end = next(i for i in range(1, len(lines)) if lines[i].startswith("=" * 60))
            lines = lines[end + 1:]
        except StopIteration:
            pass
    pages = []
    cur_label, cur = "p?", []
    for ln in lines:
        s = ln.strip()
        m = PMARK.match(s)
        if m:
            if cur:
                pages.append((cur_label, cur))
            cur_label = f"p{m.group(1)}" if m.group(1) else (f"pdf{m.group(2)}" if m.group(2) else "p?")
            cur = []
            continue
        cur.append(ln)
    if cur:
        pages.append((cur_label, cur))
    return pages


def rebuild_paragraphs(lines):
    """把 OCR 的碎行重建成段落。

    中文 OCR 每行 20-40 字，一句常被切成 2-3 行。规则：
      ① 行尾是句末标点 → 结束一段
      ② 下一行以「（一）」「1.」「·」「-」开头 → 新起一段
      ③ 累计超过 400 字 → 强制断段（防超长段）
    """
    paras, buf = [], ""
    for ln in lines:
        s = ln.strip()
        if not s:
            if buf:
                paras.append(buf)
                buf = ""
            continue
        if re.match(r"^(（[一二三四五六七八九十]+）|\([0-9]+\)|[0-9]+[．.]|·|——|第[0-9一二三四五六七八九十]+[章节])", s):
            if buf:
                paras.append(buf)
                buf = ""
        buf += s
        if s and s[-1] in SENT_END:
            paras.append(buf)
            buf = ""
        elif len(buf) > 400:
            paras.append(buf)
            buf = ""
    if buf:
        paras.append(buf)
    return [p for p in paras if len(p) >= 2]


def find_chapters(pages):
    """找章标题。返回 [(标题, 起始页索引)]，找不到就返回空。"""
    out = []
    for i, (label, lines) in enumerate(pages):
        for j, ln in enumerate(lines):
            s = ln.strip()
            if not (3 <= len(s) <= 40):
                continue
            if CHAP.match(s):
                # 前后是空行或页边界
                prev_blank = (j == 0) or (not lines[j - 1].strip())
                next_blank = (j == len(lines) - 1) or (not lines[j + 1].strip())
                if prev_blank and next_blank:
                    out.append((s[:60], i))
                    break
    # 去重保序
    seen, res = set(), []
    for t, i in out:
        if t in seen:
            continue
        seen.add(t)
        res.append((t, i))
    return res


def pdf_page_is_real_cover(pdf_path, page=1):
    """判断 PDF 某页算不算「真封面」。

    2026-11-15 加。起因：犬子说「原书有封面的就用原书封面，
    自制书不自带封面的就用那四张肥鱼」。

    原来的逻辑是「有 PDF 就用第 1 页」，但很多扫描件的第 1 页
    只是白底扉页（几行书名 + 一个符号），拿来当封面很难看。
    实测三本对比，判据如下（22 个样本验证过）：

        书                     彩色度   非白占比
        从斯密到马克思(彩色封面)   20.8    80.4%   → 真封面
        中国经济原论(彩色封面)      4.0    40.4%   → 真封面
        社论汇编1975(白底扉页)      0.0     1.2%   → 不算
        政治经济学南开(白底)        0.0     4.0%   → 不算

    判定：彩色度 > 8 或 非白占比 > 35% → 真封面。
    """
    try:
        import pymupdf
        from PIL import Image
        import numpy as np
        d = pymupdf.open(pdf_path)
        if d.page_count == 0:
            d.close(); return False
        idx = max(0, min(page - 1, d.page_count - 1))
        pix = d[idx].get_pixmap(dpi=80)
        im = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        a = np.asarray(im).astype(float)
        chroma = float(np.mean(np.abs(a[:,:,0]-a[:,:,1]) + np.abs(a[:,:,1]-a[:,:,2]) + np.abs(a[:,:,0]-a[:,:,2])))
        lum = a.mean(axis=2)
        nonwhite = float((lum < 240).mean())
        d.close()
        return chroma > 8 or nonwhite > 0.35
    except Exception:
        return True   # 判断不了就当有封面，别误伤


def find_source_pdf(txt_path, book_title=None):
    """自动找这本书的原始 PDF（用来做真封面）。

    顺序：
      ① txt 同名 .pdf（同目录）
      ② 知识库各层的 _源文件/ 目录
      ③ 常见书库目录，按书名模糊匹配

    返回 Path 或 None。找不到不报错，退回画字封面。
    """
    import re as _re
    tp = Path(txt_path)
    stem = tp.stem

    # ① 同目录同名
    for ext in (".pdf", ".PDF"):
        c = tp.with_suffix(ext)
        if c.exists():
            return c

    # ② 知识库的 _源文件 目录
    kb = Path(r"G:\path\to\knowledge-base")
    if kb.exists():
        for d in kb.rglob("_源文件"):
            for ext in ("*.pdf", "*.PDF"):
                c = d / (stem + ext[1:])
                if c.exists():
                    return c

    # ③ 书名模糊匹配（去掉"著/编/校"等尾巴再比）
    if book_title:
        key = _re.sub(r"[（(].*?[)）]", "", book_title)
        key = _re.sub(r"[·\s]", "", key)[:12]
        if len(key) >= 4:
            ROOTS = [Path(r"G:\path\to\workspace\百度网盘"), Path(r"C:\Users\YOUR_USERNAME\Documents"),
                     Path(r"G:\path\to\workspace\调研"), Path(r"C:\Users\YOUR_USERNAME\Downloads")]
            for root in ROOTS:
                if not root.exists():
                    continue
                try:
                    for f in root.rglob("*.pdf"):
                        n = _re.sub(r"[·\s（(].*$", "", f.stem)
                        if key in n or n in key:
                            return f
                except Exception:
                    continue
    return None


def make_cover_image(title, author, out_path, pdf_path=None, pdf_page=1):
    """生成封面 JPG。返回 True/False。

    两种来源：
      ① 有 PDF → 渲染第一页（最真实，就是扫描的封面）
      ② 没 PDF → PIL 画一张（深色底 + 书名 + 作者），保证不是空块

    尺寸按微信读书习惯取 800x1200（3:4.5），够清晰又不臃肿。
    """
    W, H = 800, 1200
    try:
        if pdf_path and Path(pdf_path).exists():
            import pymupdf
            from PIL import Image
            d = pymupdf.open(pdf_path)
            idx = max(0, min(pdf_page - 1, d.page_count - 1))
            pix = d[idx].get_pixmap(dpi=200)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            d.close()
            # 等比缩放到封面框内，白底补齐
            img.thumbnail((W, H), Image.LANCZOS)
            canvas = Image.new("RGB", (W, H), "white")
            canvas.paste(img, ((W - img.width)//2, (H - img.height)//2))
            canvas.save(out_path, "JPEG", quality=88)
            return True
        else:
            # 2026-11-14：自制书没有原书 PDF 时，用「大肥鱼」模板做封面。
            # 犬子指定：「用固定的几张大肥鱼样式的快捷方式图标图片当封面」。
            # 模板在 知识库\工具\.covers\fish-*.jpg，按书名 hash 稳定选一张
            # （同一本书每次构建封面都一样，不会跳）。
            import glob as _g, random as _rd
            _cov = Path(__file__).parent / ".covers"
            _tpl = sorted(list(_g.glob(str(_cov / "fish-*.jpg"))) +
                          list(_g.glob(str(_cov / "fish-*.png"))))
            if _tpl:
                import hashlib as _hl
                _h = int(_hl.md5(title.encode("utf-8")).hexdigest()[:8], 16)
                _pick = _tpl[_h % len(_tpl)]
                from PIL import Image as _I, ImageDraw as _D, ImageFont as _F
                base = _I.open(_pick).convert("RGB")
                base = base.resize((W, H), _I.LANCZOS)
                dr = _D.ImageDraw(base)
                # 底部压一条半透明色带，写书名+作者
                band_h = 190
                overlay = _I.new("RGBA", (W, band_h), (20, 24, 32, 200))
                base.paste(_I.alpha_composite(
                    base.crop((0, H-band_h, W, H)).convert("RGBA"), overlay).convert("RGB"),
                    (0, H-band_h))
                def _font(sz):
                    for fp in (r"C:\\Windows\\Fonts\\msyh.ttc", r"C:\\Windows\\Fonts\\simhei.ttf"):
                        try: return _F.truetype(fp, sz)
                        except Exception: continue
                    return _F.load_default()
                ft, fa = _font(48), _font(30)
                # 书名最多两行
                lines, cur = [], ""
                for ch in title:
                    cur += ch
                    if len(cur) >= 13:
                        lines.append(cur); cur = ""
                if cur: lines.append(cur)
                lines = lines[:2]
                y = H - band_h + 26
                for ln in lines:
                    bb = dr.textbbox((0,0), ln, font=ft)
                    dr.text(((W-(bb[2]-bb[0]))//2, y), ln, font=ft, fill=(248,249,251))
                    y += 58
                if author:
                    bb = dr.textbbox((0,0), author, font=fa)
                    dr.text(((W-(bb[2]-bb[0]))//2, y+8), author, font=fa, fill=(168,176,190))
                base.save(out_path, "JPEG", quality=90)
                return True

            from PIL import Image, ImageDraw, ImageFont
            img = Image.new("RGB", (W, H), (34, 40, 49))       # 深灰蓝
            dr = ImageDraw.Draw(img)
            # 顶部装饰条
            dr.rectangle([0, 0, W, 12], fill=(178, 141, 76))

            def font(size):
                for fp in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf",
                           r"C:\Windows\Fonts\simsun.ttc"):
                    try: return ImageFont.truetype(fp, size)
                    except Exception: continue
                return ImageFont.load_default()

            # 书名换行（每行 <= 12 字）
            f_title = font(58)
            lines, cur = [], ""
            for ch in title:
                cur += ch
                if len(cur) >= 12:
                    lines.append(cur); cur = ""
            if cur: lines.append(cur)
            lines = lines[:6]
            y = 300
            for ln in lines:
                bbox = dr.textbbox((0,0), ln, font=f_title)
                tw = bbox[2] - bbox[0]
                dr.text(((W - tw)//2, y), ln, font=f_title, fill=(245, 245, 245))
                y += 86
            # 分隔线
            dr.line([(W//2 - 90, y + 24), (W//2 + 90, y + 24)], fill=(178, 141, 76), width=3)
            # 作者
            if author:
                f_auth = font(34)
                bbox = dr.textbbox((0,0), author, font=f_auth)
                tw = bbox[2] - bbox[0]
                dr.text(((W - tw)//2, y + 60), author, font=f_auth, fill=(180, 180, 185))
            img.save(out_path, "JPEG", quality=90)
            return True
    except Exception as e:
        print(f"  ⚠ 封面生成失败: {str(e)[:60]}")
        return False


def build_epub(pages, chapters, out_path, title, author, cover_path=None):
    book_id = str(uuid.uuid4())
    # 分块：按章切页
    if chapters:
        blocks = []
        for k, (ct, ci) in enumerate(chapters):
            end = chapters[k + 1][1] if k + 1 < len(chapters) else len(pages)
            blocks.append((ct, pages[ci:end]))
        # 第 0 章之前的内容（序言等）
        if chapters[0][1] > 0:
            blocks.insert(0, ("前言", pages[:chapters[0][1]]))
    else:
        blocks = [(title, pages)]

    files = {}
    nav_items = []
    for idx, (ct, pgs) in enumerate(blocks, 1):
        all_lines = []
        for _, ls in pgs:
            all_lines.extend(ls)
        paras = rebuild_paragraphs(all_lines)
        if not paras:
            continue
        fn = f"chap{idx:03d}.xhtml"
        body = "\n".join(f"<p>{html.escape(p)}</p>" for p in paras)
        files[fn] = f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>{html.escape(ct)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<h2>{html.escape(ct)}</h2>
{body}
</body></html>'''
        nav_items.append((ct, fn))

    if not nav_items:
        print("❌ 没有任何内容，放弃")
        return False

    # nav.xhtml —— 微信读书认这个
    toc_lis = "\n".join(
        f'<li><a href="{fn}">{html.escape(t)}</a></li>' for t, fn in nav_items)
    nav = f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>{html.escape(title)}</title></head>
<body><nav epub:type="toc" id="toc"><h1>{html.escape(title)}</h1>
<ol>{toc_lis}</ol></nav></body></html>'''

    style = '''body{font-family:serif;line-height:1.75;margin:0.8em;}
h2{font-size:1.15em;margin:1.2em 0 0.8em;font-weight:bold;}
p{text-indent:2em;margin:0.55em 0;}'''

    manifest = "\n".join(
        f'    <item id="c{i}" href="{fn}" media-type="application/xhtml+xml"/>'
        for i, (_, fn) in enumerate(nav_items, 1))
    cover_item = ""
    cover_meta = ""
    if cover_path:
        cover_item = '    <item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>'
        cover_meta = '    <meta name="cover" content="cover-img"/>'
    # 2026-11-14：封面页 xhtml（微信读书靠 properties="cover-image" 认封面，
    #   但有些版本还要一个 xhtml 页，两个都放）
    spine = "\n".join(f'    <itemref idref="c{i}"/>' for i in range(1, len(nav_items) + 1))
    opf = f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
{cover_meta}
    <dc:identifier id="bookid">urn:uuid:{book_id}</dc:identifier>
    <dc:title>{html.escape(title)}</dc:title>
    <dc:creator>{html.escape(author)}</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
{cover_item}
    <item id="css" href="style.css" media-type="text/css"/>
{manifest}
  </manifest>
  <spine>
{spine}
  </spine>
</package>'''

    container = '''<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf"
    media-type="application/oebps-package+xml"/></rootfiles>
</container>'''

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container)
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/nav.xhtml", nav)
        z.writestr("OEBPS/style.css", style)
        for fn, content in files.items():
            z.writestr(f"OEBPS/{fn}", content)
        if cover_path and Path(cover_path).exists():
            z.write(str(cover_path), "OEBPS/cover.jpg")
    return True


def toc_from_pdf(pdf_path, depth=2):
    """从 PDF 书签取目录。返回 [(标题, 印刷页码)]。

    depth=2 表示取 L1+L2（篇/章），只用 L1 会漏掉「第X章」，
    只用 L2 有的书又没有。
    """
    import pymupdf
    d = pymupdf.open(pdf_path)
    toc = d.get_toc()
    d.close()
    FRONT = re.compile(r"^(封面|书名|版权|前言|目录|扉页|序言?|附录|后记)")
    out = []
    for lvl, t, pg in toc:
        t = t.strip()
        if not t or pg <= 0 or lvl > depth:
            continue
        if FRONT.match(t) and lvl == 1:
            continue
        out.append((t[:60], int(pg), "page"))
    return out


def toc_from_json(json_path):
    """从 JSON 清单取目录。

    支持两种字段：
      {"name":.., "start": 印刷页码}   —— OCR 书的目录
      {"name":.., "line": 行号}        —— 无页标记的书（如 EPUB 转来的托洛茨基选集）
    """
    import json as _json
    items = _json.loads(Path(json_path).read_text(encoding="utf-8"))
    out = []
    for x in items:
        if "start" in x:
            out.append((x["name"][:60], int(x["start"]), "page"))
        elif "line" in x:
            out.append((x["name"][:60], int(x["line"]), "line"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--title", default=None)
    ap.add_argument("--author", default="")
    # 2026-11-12 加：目录来源。
    #   实测柯尔施那本正文里找不到「第X章」格式的标题（按篇名分），
    #   txt 自动识别必然 0 章，整本挤成一章，微信读书里没法跳转。
    #   所以给两个外部来源：--pdf 读 PDF 书签，--toc 读 JSON 清单。
    ap.add_argument("--pdf", default=None, help="从这本 PDF 的书签取目录")
    ap.add_argument("--toc", default=None, help='JSON 清单 [{"name":..,"start":页码}, ...]')
    # 2026-11-14 加（犬子反馈：「上传的两本书为啥没有封面」）：
    #   原工具根本不生成封面，微信读书里就是灰块。
    #   --cover-pdf  从原书 PDF 第 1 页渲染封面（最真实）
    #   --cover-text 没有 PDF 时，用书名自动画一张（纯色底+书名+作者）
    ap.add_argument("--cover-pdf", default=None, help="从这本 PDF 的第一页生成封面")
    ap.add_argument("--cover-page", type=int, default=1, help="用 PDF 第几页做封面（默认1）")
    args = ap.parse_args()

    pages = read_pages(args.src)
    print(f"读入 {len(pages)} 页")

    # 2026-11-12：EPUB 转来的 txt 没有页标记（没有【pN】/[PDFpN]），
    #   read_pages 会返回 1 个巨页。这时改按行切：每 200 行算一"页"，
    #   让目录里的 line 字段能落到具体块上。
    if len(pages) <= 2:
        raw_lines = Path(args.src).read_text(encoding="utf-8", errors="replace").split("\n")
        # 跳过文件头
        if raw_lines and raw_lines[0].startswith("="):
            try:
                e = next(i for i in range(1, len(raw_lines)) if raw_lines[i].startswith("=" * 60))
                raw_lines = raw_lines[e+1:]
            except StopIteration:
                pass
        # 2026-11-12：块要切细，否则目录映射不出章。
        #   实测托洛茨基选集 27,123 行，按 200 行切只有 136 块，
        #   449 条目录里 440 条落不到独立块上（多个目录指向同一块），最终只剩 9 章。
        #   按 20 行切 → 1,357 块，目录能落到各自的位置。
        CH = 20
        pages = [(f"L{i+1}", raw_lines[i:i+CH]) for i in range(0, len(raw_lines), CH)]
        print(f"无页标记，按行切块：{len(pages)} 块（每块 {CH} 行）")

    # 2026-11-12：按行号定位时，块不必等长，直接按目录节点切。
    #   原做法是「固定 20 行一块 + 目录映射到块」，多个目录落同一块就合并，
    #   449 条目录只剩 34 章。现在改成：按目录的 line 值切，一条目录一块。
    ext_probe = []
    if args.toc:
        ext_probe = toc_from_json(args.toc)
    if ext_probe and ext_probe[0][2] == "line":
        raw = Path(args.src).read_text(encoding="utf-8", errors="replace").split("\n")
        if raw and raw[0].startswith("="):
            try:
                e = next(i for i in range(1, len(raw)) if raw[i].startswith("=" * 60))
                raw = raw[e+1:]
            except StopIteration:
                pass
        cuts = sorted({num for _, num, _ in ext_probe if 1 <= num <= len(raw)})
        blocks, starts = [], []
        for k, st in enumerate(cuts):
            en = cuts[k+1] if k+1 < len(cuts) else len(raw)
            blocks.append((f"L{st}", raw[st-1:en-1]))
            starts.append(st)
        # 重建 chapters：名字按 line 对齐
        name_by_line = {}
        for t, num, _ in ext_probe:
            if num not in name_by_line:
                name_by_line[num] = t
        chapters = [(name_by_line.get(st, f"第{st}行"), i) for i, st in enumerate(starts)]
        pages = blocks
        print(f"按目录节点切块：{len(chapters)} 章")
    else:
        chapters = []

    # 目录来源优先级：--toc > --pdf > 正文自动识别
    ext = []
    if args.toc:
        ext = toc_from_json(args.toc)
        print(f"从 JSON 清单取目录 {len(ext)} 条")
    elif args.pdf:
        ext = toc_from_pdf(args.pdf)
        print(f"从 PDF 书签取目录 {len(ext)} 条")

    if chapters:
        pass   # 已按目录节点切好
    elif ext:
        # 外部目录给的是「印刷页码」，要映射到 pages 的索引。
        # pages 的 label 形如 p123 / pdf45 / p?
        # 建 label→索引 表，印刷页码优先，没有就用 pdf 页序。
        idx_by_printed, idx_by_pdf = {}, {}
        for i, (label, _) in enumerate(pages):
            m = re.match(r"^p(\d+)$", label)
            if m:
                idx_by_printed[int(m.group(1))] = i
            m2 = re.match(r"^pdf(\d+)$", label)
            if m2:
                idx_by_pdf[int(m2.group(1))] = i
        chapters = []
        for t, num, kind in ext:
            if kind == "line":
                # 行号 → 块索引（块标签是 L{起始行}）
                i = None
                for bi, (label, _) in enumerate(pages):
                    m = re.match(r"^L(\d+)$", label)
                    if m and int(m.group(1)) <= num:
                        i = bi
                if i is not None:
                    chapters.append((t, i))
                continue
            i = idx_by_printed.get(num)
            if i is None:
                i = idx_by_pdf.get(num)
            if i is None:
                continue
            chapters.append((t, i))
        # 去重保序
        seen, ded = set(), []
        for t, i in chapters:
            if i in seen:
                continue
            seen.add(i)
            ded.append((t, i))
        chapters = sorted(ded, key=lambda x: x[1])
        print(f"映射到正文 {len(chapters)} 章")
    else:
        chapters = find_chapters(pages)
        print(f"正文里识别章标题 {len(chapters)} 个")
    for t, i in chapters[:10]:
        print(f"   页索引{i:<5} {t}")
    title = args.title or Path(args.src).stem
    # 2026-11-14：生成封面
    import tempfile as _tf
    cover_tmp = str(Path(_tf.gettempdir()) / f"_cover_{abs(hash(title))%99999}.jpg")
    _cp = getattr(args, "cover_pdf", None)
    # 2026-11-14：没手动指定就自动找原书 PDF，找到就用真封面
    # 2026-11-15 修：找到 PDF 还要判断第1页是不是真封面。
    #   白底扉页（彩色度低、几乎全白）不算，退回大肥鱼模板。
    if not _cp:
        _found = find_source_pdf(args.src, title)
        if _found:
            if pdf_page_is_real_cover(_found, getattr(args, "cover_page", 1)):
                _cp = str(_found)
                print(f"  封面源: 自动找到 {_found.name}（第1页是真封面）")
            else:
                print(f"  封面源: {_found.name} 第1页是白底扉页 → 改用大肥鱼模板")
    if make_cover_image(title, args.author, cover_tmp, _cp, getattr(args, "cover_page", 1)):
        print(f"  封面: {'PDF第' + str(args.cover_page) + '页' if _cp else '自动生成'}")
    else:
        cover_tmp = None
    ok = build_epub(pages, chapters, args.dst, title, args.author, cover_path=cover_tmp)
    if ok:
        sz = Path(args.dst).stat().st_size
        n_par = sum(len(rebuild_paragraphs([l for _, ls in pgs for l in ls]))
                    for _, pgs in [(t, pages[i:(chapters[k+1][1] if k+1 < len(chapters) else len(pages))])
                                   for k, (t, i) in enumerate(chapters)] if chapters) if chapters else 0
        print(f"✅ {args.dst}  {sz/1024:.0f} KB")


if __name__ == "__main__":
    main()
