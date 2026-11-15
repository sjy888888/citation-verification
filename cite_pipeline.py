# -*- coding: utf-8 -*-
"""cite_pipeline.py —— 引用一条龙：查原文 → 出引用串 → 双检（页码+文字）

2026-11-10 用户：「重点核查优化一下原著引用的正确性与准确性。」

一个命令跑完六步：
  ① 检索原文（quote.mjs --gb）
  ② 输出 GB/T 7714 引用串
  ③ 回 PDF 核页码（verify_cite.py）
  ④ 回 PDF 核文字（verify_text.py）
  ⑤ 三态标注检查（cite_check.py）
  ⑥ 给出结论：能不能直接写进论文

用法：
  python cite_pipeline.py "异化劳动"
  python cite_pipeline.py "哲学家们只是用不同的方式解释世界"
"""
import json
import re
import subprocess
import sys
from pathlib import Path

NODE = r"node"
DIR = Path(r"G:\path\to\knowledge-base\工具")


def sh(args, timeout=300):
    try:
        r = subprocess.run(args, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
        return (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return f"[ERR] {e}"


def main():
    if len(sys.argv) < 2:
        print('用法: python cite_pipeline.py "关键词或原句"')
        sys.exit(1)
    q = " ".join(sys.argv[1:])

    print(f"\n{'='*72}")
    print(f"查询：{q}")
    print("=" * 72)

    # ① 检索 + ② 引用串
    out = sh([NODE, str(DIR / "quote.mjs"), "-n", "1", "--exact", q, "--gb"])
    cite = None
    for ln in out.splitlines():
        m = re.search(r"〔引用〕(.+)", ln)
        if m:
            cite = m.group(1).strip()
            break
    if not cite:
        print("\n① 检索：❌ 库里没找到")
        print(out.strip()[:400])
        sys.exit(1)

    # 书 + 页
    pm = re.search(r"第\s*(\d+)\s*页", cite)
    # 2026-11-10 修：不能取「第一个书名号」——引用串第一个书名号常是篇名
    #   （如《政治经济学批判》序言，《马克思恩格斯文集》第2卷…）。
    #   要取**紧挨着「第N卷」的那个书名号**。
    bm = re.search(r"《([^》]+)》\s*第\s*\d+\s*卷", cite) or re.search(r"《([^》]+)》", cite)
    print(f"\n① 检索：✅ 命中")
    print(f"② 引用串：{cite}")

    if not pm or not bm:
        print("\n⚠ 引用串里没有「第N页」或没有书名 —— 这条不能直接引")
        sys.exit(0)

    page = int(pm.group(1))
    book_raw = bm.group(1)
    print(f"\n③ 核页码：", end="")

    # ③ 页码核对
    # 2026-11-10 修：引用串里的书名可能是**文件名**（如「马恩全集2版-第31卷-1857-1861」），
    #   verify_cite 的 find_pdf 是按「文集/选集/全集 + 第N卷」认的，认不出文件名，
    #   于是明明有 PDF 也报「核不了」。这里先把书名规范成它能认的形态。
    cite_for_verify = cite
    vm0 = re.search(r"第\\s*(\\d+)\\s*卷", cite)
    if vm0:
        n0 = vm0.group(1)
        if "文集" in cite:
            cite_for_verify = f"《马克思恩格斯文集》第{n0}卷，{cite.split('，',1)[-1]}"
        elif "选集" in cite:
            cite_for_verify = f"《马克思恩格斯选集》第{n0}卷，{cite.split('，',1)[-1]}"
        elif "全集" in cite:
            cite_for_verify = f"《马克思恩格斯全集》第{n0}卷，{cite.split('，',1)[-1]}"
    vc = sh([sys.executable, str(DIR / "verify_cite.py"),
             "--quote", cite_for_verify])
    if "VERIFIED" in vc:
        print("✅ 原页上确实印着这个页码")
    elif "MISMATCH" in vc:
        print("❌ 原页上找不到这个页码")
        print("   " + "\n   ".join(vc.strip().splitlines()[:6]))
    else:
        print("⚠ 无法核（找不到 PDF 原件）")

    # ④ 文字核对 —— 拿库里命中的那句原文去比
    hit_line = ""
    for ln in out.splitlines():
        if re.search(r"^\s+p\d+", ln) or "「" in ln:
            hit_line = ln
            break
    m = re.search(r"「(.+?)」", hit_line)
    if m and "VERIFIED" in vc:
        text = m.group(1).replace("…", "").replace("⏎", "")
        text = re.sub(r"〔篇〕[^｜]*｜", "", text)
        if len(text) > 8:
            print(f"\n④ 核文字：", end="")
            # 2026-11-10 修：书名要还原成「文集第1卷」这种带卷号的形态，
            # verify_text 的 find_pdf 是按「文集\s*第?\s*(\d+)\s*卷」认的，
            # 只给「马克思恩格斯文集」它认不出。
            vol = ""
            vm = re.search(r"第\s*(\d+)\s*卷", cite)
            if vm:
                n = vm.group(1)
                if "文集" in book_raw:
                    vol = f"文集第{n}卷"
                elif "选集" in book_raw:
                    vol = f"选集第{n}卷"
                elif "全集" in book_raw:
                    vol = f"全集第{n}卷"
            if not vol:
                print("⚠ 认不出是哪一套书")
            else:
                vt = sh([sys.executable, str(DIR / "verify_text.py"),
                         "--book", vol, "--page", str(page),
                         "--text", text[:80]])
                if "VERIFIED" in vt:
                    print("✅ 引文逐字出现在原页")
                elif "MINOR_DIFF" in vt or "MAJOR_DIFF" in vt:
                    print("⚠ 文字有出入")
                    for ln in vt.splitlines():
                        if "你写" in ln:
                            print("   " + ln.strip())
                else:
                    print("⚠ 无法核")
                    for ln in vt.splitlines()[:3]:
                        if ln.strip():
                            print("   " + ln.strip())

    # ⑤ 三态检查
    print(f"\n⑤ 三态检查：", end="")
    cc = sh([sys.executable, str(DIR / "cite_check.py"),
             "--text", f"引文（{cite.rstrip('。')}）"])
    if "未发现三态问题" in cc:
        print("✅ 合规")
    else:
        print("⚠ 有问题")
        for ln in cc.splitlines():
            if ln.strip().startswith("[") or "无出处" in ln:
                print("   " + ln.strip())

    print(f"\n{'='*72}")
    print("⑥ 结论：")
    if "VERIFIED" in vc:
        print(f"   可以直接写进论文：{cite}")
        print("   但提交前仍建议自己翻一眼原书 —— 机器核过不等于万无一失。")
    else:
        print("   这条目前不能直接引。页码核不了，只引文字、不写页码，或自己查纸本。")


if __name__ == "__main__":
    main()
