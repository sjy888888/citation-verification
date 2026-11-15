# -*- coding: utf-8 -*-
"""fix_covers.py —— 给产出目录里缺封面的 epub 补封面

2026-11-14。起因：犬子传了两本书到微信读书，显示灰块没封面。

根因：txt2epub.py 原先不生成封面。已加：
    ① --cover-pdf  或自动找原书 PDF → 用真封面
    ② 没有 PDF → 大肥鱼模板 + 底部写书名作者

但这个脚本解决的是**存量**：产出目录里已经生成的 epub 还是没封面的。
做法：直接把改造好的 cover.jpg 塞进 zip 的 OEBPS/cover.jpg，
      并改 content.opf 加 cover-image 属性 + <meta name="cover">。

用法：
    python fix_covers.py            # 列出哪些缺封面
    python fix_covers.py --apply    # 真的补
"""
import argparse
import io
import re
import shutil
import sys
import zipfile
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

OUTDIR = Path(r"G:\path\to\knowledge-base\产出")
TOOLS = Path(r"G:\path\to\knowledge-base\工具")
COVERS = TOOLS / ".covers"


def pick_fish(title):
    """按书名稳定选一张肥鱼模板（同一本书每次都一样）

    2026-11-14：支持 png/jpg 混合（犬子重新给了 4 张图，是 png）。
    """
    tpl = sorted(list(COVERS.glob("fish-*.jpg")) + list(COVERS.glob("fish-*.png")))
    if not tpl:
        return None
    # 用确定性哈希，别用 Python 的 hash()（每次进程不同）
    import hashlib
    h = int(hashlib.md5(title.encode("utf-8")).hexdigest()[:8], 16)
    return tpl[h % len(tpl)]


def make_cover_jpg(title, author, out_path):
    """生成封面：肥鱼模板 + 底部书名带（不 import txt2epub，避免 stdout 被关）"""
    from PIL import Image, ImageDraw, ImageFont
    W, H = 800, 1200
    tpl = pick_fish(title)
    if tpl:
        base = Image.open(tpl).convert("RGB").resize((W, H), Image.LANCZOS)
    else:
        base = Image.new("RGB", (W, H), (34, 40, 49))
    dr = ImageDraw.Draw(base)

    band_h = 190
    band = base.crop((0, H - band_h, W, H)).convert("RGBA")
    ov = Image.new("RGBA", (W, band_h), (20, 24, 32, 205))
    base.paste(Image.alpha_composite(band, ov).convert("RGB"), (0, H - band_h))

    def _font(sz, bold=False):
        for fp in (r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc",
                   r"C:\Windows\Fonts\simhei.ttf"):
            try:
                return ImageFont.truetype(fp, sz)
            except Exception:
                continue
        return ImageFont.load_default()

    ft, fa = _font(46, True), _font(28)
    lines, cur = [], ""
    for ch in title:
        cur += ch
        if len(cur) >= 13:
            lines.append(cur); cur = ""
    if cur: lines.append(cur)
    lines = lines[:2]
    y = H - band_h + 26
    for ln in lines:
        bb = dr.textbbox((0, 0), ln, font=ft)
        dr.text(((W - (bb[2] - bb[0])) // 2, y), ln, font=ft, fill=(248, 249, 251))
        y += 58
    if author:
        bb = dr.textbbox((0, 0), author, font=fa)
        dr.text(((W - (bb[2] - bb[0])) // 2, y + 8), author, font=fa, fill=(170, 178, 192))
    base.save(out_path, "JPEG", quality=90)
    return True


def add_cover_to_epub(epub_path, cover_jpg):
    """把 cover.jpg 塞进 epub，并改 opf。返回 True/False"""
    p = Path(epub_path)
    tmp = p.with_suffix(".tmp.epub")
    ok = False
    try:
        with zipfile.ZipFile(p, "r") as zin:
            names = zin.namelist()
            # 找 opf
            opf_name = next((n for n in names if n.endswith("content.opf")), None)
            if not opf_name:
                return False
            opf = zin.read(opf_name).decode("utf-8", "replace")
            opf_dir = opf_name.rsplit("/", 1)[0] + "/" if "/" in opf_name else ""

            # 已声明封面就不再动
            if "cover-image" in opf:
                return False

            # 注入 manifest / metadata
            if '<meta name="cover"' not in opf:
                opf = opf.replace("</metadata>",
                                  '  <meta name="cover" content="cover-img"/>\n</metadata>', 1)
            if 'id="cover-img"' not in opf:
                opf = opf.replace("</manifest>",
                                  '  <item id="cover-img" href="cover.jpg" '
                                  'media-type="image/jpeg" properties="cover-image"/>\n</manifest>', 1)

            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
                for n in names:
                    if n == opf_name:
                        zout.writestr(n, opf)
                    else:
                        zout.writestr(n, zin.read(n))
                zout.write(str(cover_jpg), opf_dir + "cover.jpg")
        shutil.move(str(tmp), str(p))
        ok = True
    except Exception as e:
        print(f"      ⚠ {str(e)[:70]}")
        if tmp.exists():
            tmp.unlink()
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    eps = sorted(OUTDIR.glob("*.epub"))
    missing, has, broken = [], [], []
    for e in eps:
        try:
            z = zipfile.ZipFile(e)
            if any("cover" in n.lower() and n.lower().endswith((".jpg", ".jpeg", ".png"))
                   for n in z.namelist()):
                has.append(e)
            else:
                missing.append(e)
        except Exception:
            broken.append(e)

    print(f"产出目录 {len(eps)} 个 epub")
    print(f"  有封面 {len(has)}   缺封面 {len(missing)}   损坏 {len(broken)}\n")

    if not missing:
        print("✅ 全部都有封面")
        return

    print("缺封面的：")
    for e in missing:
        print(f"   {e.stat().st_size//1024:>6} KB  {e.name}")

    if not args.apply:
        print("\n（加 --apply 才补）")
        return

    print("\n开始补：")
    tmp_cover = Path(r"G:\path\to\workspace\_备份-知识库") / "_tmp_cover.jpg"
    tmp_cover.parent.mkdir(parents=True, exist_ok=True)
    ok_n = 0
    for e in missing:
        title = e.stem
        # 从文件名拆作者：只有「第一段像人名」时才拆
        # 2026-11-14 修：「马发史背诵笔记-马工程版」被误拆成 作者=马发史背诵笔记。
        #   判据收紧：第一段 2-5 个汉字，且不含「笔记/选集/杂志/教程/原理」等书名词。
        author = ""
        if "-" in title:
            head, rest = title.split("-", 1)
            BAD = ("笔记", "选集", "杂志", "教程", "原理", "研究", "导论", "讲义",
                   "文集", "全书", "读本", "纲要", "概论", "史", "论")
            if 2 <= len(head) <= 5 and not any(b in head for b in BAD) and head != rest:
                author, title = head, rest
        if make_cover_jpg(title, author, tmp_cover):
            if add_cover_to_epub(e, tmp_cover):
                print(f"   ✅ {e.name}")
                ok_n += 1
            else:
                print(f"   ⚠ 已在/失败 {e.name}")
        else:
            print(f"   ❌ 封面生成失败 {e.name}")
    print(f"\n补了 {ok_n} / {len(missing)}")


if __name__ == "__main__":
    main()
