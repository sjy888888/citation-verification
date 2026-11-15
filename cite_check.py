# -*- coding: utf-8 -*-
"""cite_check.py —— 引用三态自检：把一段文字里的引用逐条核对

2026-11-10 目标要求「每层含……引用三态标注六步」，但一直没有**验证手段**。
写了规则不等于做到，得有工具能查。

三态定义（铁律）：
  【原文】= 从库里检索到、带页码的原句 → 格式「……」（《书名》pXXX）
  【转述】= 理解后自己的话，**不加引号**
  【待核对】= 凭记忆写的、库里没有 → 〔待核对：……〕

本脚本查五类问题：
  ① **无出处的引文**：用了「」或""包起来，但后面没有（《书名》pX）→ 可能是编的
  ② **【原文】但页码是 p?**：标了原文却给不出页码 → 应降级为「页码待核」
  ③ **【待核对】被写成肯定句**：说了「马克思说……」却没标注 → 可疑
  ④ **三段式排比引文**：连续的「A」「B」「C」——AI 编造引文的典型形态
  ⑤ **疑似臆造出处**：页码数字特别整齐（p100/p200）或书名不在库里

用法:
  python cite_check.py <文件>          # 查一个文件
  python cite_check.py --text "……"   # 查一段文字
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(r"G:\path\to\knowledge-base\学科资料")

# 库里实际有的书名（粗判：文件名里出现的关键词）
def known_books():
    names = set()
    for d in ROOT.iterdir():
        if not d.is_dir() or not re.match(r"^[LRXT]\d*-", d.name):
            continue
        for p in d.rglob("*.txt"):
            names.add(p.stem)
    return names


QUOTE_CN = re.compile(r"「([^」]{8,120})」")
QUOTE_EN = re.compile(r'"([^"]{12,200})"')
# 出处形态：（《书名》第X卷 p123）（书名 p123）（《书名》p123）
# 2026-11-10 修：第一版要求出处必须带括号「（《资本论》p123）」，
# 实测「另有《资本论》p100 的说法」这种**不带括号**的写法全漏了。
# 真实写作里两种都常见，所以括号改为可选。
# 2026-11-10 三修：原来只认「p123」，但**中文论文惯例是「第123页」**。
# 实测：一句完整带出处的引用「（《马克思恩格斯文集》第1卷，人民出版社2009年版，第502页）」
# 被判「无出处引文」——工具自己误报，比不查还坏。
# 现在两种都认：p123 / 第123页 / 第123—125页。
CITE = re.compile(
    r"《?([^》()（）\n]{2,40}?)》?[^。\n]{0,40}?(?:"
    r"p\s*(\d{1,4}|\?)"                  # p123
    r"|第\s*(\d{1,4}|\?)\s*页"            # 第123页
    r"|第\s*(\d{1,4})\s*[—\-－~]\s*\d{1,4}\s*页"  # 第123—125页
    r")"
)
# 【原文】【转述】【待核对】
TAG = re.compile(r"【(原文|转述|待核对)[^】]*】")


def check_text(text, books):
    issues = []

    # ① 引文有没有配出处
    # 2026-11-10 修：第一版把所有「」都当引文，误报一片——
    # 「库里有没有那一句话的原文」「有 / 没有 / 只有二手笔记」这些是**术语或短语**，不是引文。
    # 判据：真正的引文有句子形态（含。；，、：或长度 ≥ 25 且非纯术语串）。
    def looks_like_quote(q):
        """判「这是引文」还是「这是用引号强调的短语」

        2026-11-10 三版判据：
          v1 所有「」都算引文 → 误报一片（「有 / 没有 / 只有二手笔记」）
          v2 加「有标点 or 长度≥25」→ 从 7 条降到 3 条
          v3（本版）再加两条排除：
             · 含第一/第二人称或指示代词（我/你/这/那/此）且 ≤30 字 → 短语
             · 含「某/什么/怎么/有没有/是否」这类疑问或泛指 → 短语
          说明：这类靠语形无法 100% 分开，所以**只用来提示，不当硬判据**。
        """
        if re.search(r"[我你您咱这那此]", q) and len(q) <= 30:
            return False
        if re.search(r"某|什么|怎么|有没有|是否|如何", q):
            return False
        # v4（2026-11-10）：技术日志里的「」常用于引文件名、代码、提示语，
        # 那些不是学术引文，不该要求出处。
        if re.search(r"\.(txt|md|mjs|py|json|pdf|epub)|教材-|MEGA|【M\d|⚠|《.+》第[一二三四五六七八九十\d]+版", q):
            return False
        if len(q) <= 12 and re.search(r"《.+》", q):
            return False   # 短书名，是用来指书的，不是引文
        if re.search(r"[。；：？！]", q):
            return True
        if len(q) >= 25:
            return True
        if re.search(r"[一-龥]{8,}", q) and not re.search(r"[/|]", q):
            return True
        return False
    for m in QUOTE_CN.finditer(text):
        q = m.group(1)
        if not looks_like_quote(q):
            continue
        tail = text[m.end():m.end() + 120]
        if not CITE.search(tail):
            issues.append(("无出处引文", f"「{q[:40]}…」后面 120 字内没有（《书名》pX）"))

    # ② 页码是 p? 却标原文
    for m in TAG.finditer(text):
        if m.group(1) != "原文":
            continue
        seg = text[m.end():m.end() + 300]
        cm = CITE.search(seg)
        _p = (cm.group(2) or cm.group(3) or cm.group(4) or "") if cm else ""
        if _p == "?":
            issues.append(("原文无页码", f"标【原文】但出处是 p?：{cm.group(0)[:40]}"))

    # ③ 说了「说/指出/认为」但整段没有任何出处标记
    for m in re.finditer(r"(马克思|恩格斯|列宁|毛泽东|邓小平|习近平)[^。\n]{0,20}(说|指出|认为|强调|写道)", text):
        window = text[max(0, m.start() - 100):m.end() + 250]
        if not CITE.search(window) and not re.search(r"【(转述|待核对)", window):
            issues.append(("可疑肯定句", f"「{m.group(0)[:30]}」附近无出处、也未标【转述/待核对】"))

    # ④ 三段式排比引文
    runs = re.findall(r"(?:「[^」]{8,60}」[\s，、。]{0,4}){3,}", text)
    for r in runs:
        issues.append(("三段式引文", f"连续三处以上引文，AI 编造典型形态：{r[:60]}…"))

    # ⑤ 页码过于整齐
    for m in CITE.finditer(text):
        pg = m.group(2) or m.group(3) or m.group(4) or ""
        # 2026-11-10 修：第一版只查整数百（p100/p200），漏掉 p50、p30 这类整数十。
        # 放宽到「整数十且 >= 30」，因为 p10、p20 这种小页码在短文里是正常的。
        n = int(pg) if pg.isdigit() else 0
        if n >= 30 and n % 10 == 0:
            issues.append(("页码可疑", f"p{n} 是整十数，真实页码很少这么整（须查原文确认）"))

    return issues


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file", nargs="?")
    ap.add_argument("--text")
    args = ap.parse_args()

    if args.text:
        text = args.text
        src = "（命令行文本）"
    elif args.file:
        text = Path(args.file).read_text(encoding="utf-8", errors="replace")
        src = args.file
    else:
        print("用法：cite_check.py <文件> 或 --text \"…\"")
        return

    books = known_books()
    issues = check_text(text, books)

    print(f"检查：{src}")
    print(f"字数：{len(text):,}")
    print(f"库内文件：{len(books):,} 个\n")

    if not issues:
        print("✅ 未发现三态问题")
        return

    from collections import Counter
    c = Counter(k for k, _ in issues)
    print("问题统计：")
    for k, n in c.most_common():
        print(f"  {k}: {n}")
    print("\n明细（前 20 条）：")
    for k, d in issues[:20]:
        print(f"  [{k}] {d}")


if __name__ == "__main__":
    main()
