# citation-verification

**引文三态核验：把「别乱引」从口号变成可执行检查。**

## 问题

写论文引用一句话，其实有三件事要同时成立：

1. 这句话**真的存在**于那本书
2. 这句话在那本书**第几页**
3. 你**记得的措辞**和原文一字不差

三件事任何一件不成立，这条引用就是假的。而人脑在这一点上极不可靠：读过的句子会被记忆重写，措辞会被磨平，页码会被张冠李戴。

这个仓干的事：**把这三件事拆成三个可执行的检查。**

## 三态

引用分三种状态，不许混着说：

| 状态 | 含义 | 处理 |
|---|---|---|
| **原文** | 刚从工具结果逐字复制，附篇名/卷次/章节 | 可以直接引 |
| **转述** | 自己的概括 | 不加引号，不冒充原文 |
| **待核对** | 记得有出处但本次没取到 | 写「待核对，暂不引」 |

页码只有工具返回内容明确含该页码时才写，否则写「页码待核对」。

## 脚本

### 核验链

| 文件 | 干什么 |
|---|---|
| `cite_pipeline.py` | **一条龙六步**：查原文 → 出 GB/T 7714 串 → 回 PDF 核页码 → 核文字 → 三态检查 → 给结论能不能写进论文 |
| `cite_check.py` | 三态自检：把一段文字里的引用逐条核对 |
| `verify_cite.py` | 拿引用串回 PDF 原件核对 |
| `verify_text.py` | **文字级复检**：txt 里的原句和 PDF 原页逐字比对（不是模糊匹配） |
| `verify_all_cites.py` | 库里所有经典引文批量复检 |
| `verify_cites_batch.py` | 分批核验，可断点续跑 |
| `cite_roundtrip.py` | 端到端：检索 → 引用串 → 反查核验 |
| `bib-manage.py` | 轻量 BibTeX 文献库管理，无外部依赖 |

### 检索

| 文件 | 干什么 |
|---|---|
| `quote.mjs` | **引文定位器**：只搜原文目录，回答「这句话在《哪卷》第几页，原句是什么」 |
| `kb.mjs` | 打分检索 v3：bigram 切分 + BM25 加权 + 状态感知 |
| `build-inverted.mjs` / `build-inverted2.mjs` | 给检索建倒排索引（v2 分片存储，避免一次性 parse 61 MB JSON） |
| `regress_kb.py` / `regress_quote.py` | 上面两个的回归测试 |

### 知识库索引

| 文件 | 干什么 |
|---|---|
| `kb-index.mjs` | 目录自动生成：覆盖率 100% + 死链检测 + 状态位 |
| `kb-out-index.mjs` | 产出分区目录生成器 |
| `kb-status.mjs` | 状态位回填与校验（active / superseded / obsolete / corrected） |
| `kb-secret-scan.mjs` | 扫描知识库里有无明文凭据 |
| `kb_health.py` | 全库体检 |

### EPUB 导出

| 文件 | 干什么 |
|---|---|
| `txt2epub.py` | 纯文本 → EPUB，微信读书友好 |
| `jsonl2epub5.py` | OCR 行级 JSONL → EPUB：两级书签 + 引文转章末注释 + 引号修复 + 听书排版 |
| `citations.py` | 引文转章末注释（TTS 朗读不被引文打断） |
| `toc_from_tocpage.py` | 从书的「目录页」建 EPUB 目录 |
| `fix_covers.py` | 给缺封面的 epub 补封面 |
| `weread.py` | 知识库 → 微信读书入口 |

## 值得一看的 bug 与教训

### `kb.mjs` 的 coverage 指标曾经完全失效

注释原文：

> **coverage 按 term（bigram）算，不按输入词算**（最要命的一条）
>
> 旧：`matchedWords / wordTermSets.length`。而「知识库分区整理」只是**一个**输入词，被拆成 知识|识库|库分|分区|区整|整理 后，只要命中任意一个 bigram，`matchedWords` 就等于 1，coverage = 1/1 = 100%，于是「只沾了个『知识』」也被标成「全词命中」。
>
> 实测 576 个文件同时满分——这个指标等于没有。

**教训**：指标的分母选错，指标就变成噪声。

### `txt2epub.py` 为什么另起一个工具

注释原文：

> 2026-11-12 为什么不用 jsonl2epub5.py：那个工具依赖 PDF 书签 + 行坐标（y0/y1/x0/x1）来做分章和段落重建。我们的 OCR 输出是**纯文本行**，没有坐标。硬加伪坐标后能跑，但结果不对：书签是「中译本序/马克思主义和哲学/…」这种篇名，没有「第X章」；4 章只写进 3 章，p3-p29 整段丢失；20 个段落，全书 32 万字符只剩 9 万。
>
> **坐标体系对不上，适配代价大于重写。**

**教训**：两个工具的数据模型不兼容时，硬适配通常是错的选择。

## 用法

```bash
# 完整核验一条引文
python cite_pipeline.py "异化劳动"
python cite_pipeline.py "哲学家们只是用不同的方式解释世界"

# 只定位原文
node quote.mjs 异化劳动
node quote.mjs --exact "无论哪一个社会形态"

# 重建知识库目录
node kb-index.mjs
node kb-index.mjs --check     # 只检查不写
node kb-out-index.mjs
```

## 路径

本仓已把作者本机路径替换为占位符：

| 占位符 | 含义 |
|---|---|
| `YOUR_USERNAME` | Windows 用户名 |
| `G:\path\to\knowledge-base` | 语料库根目录 |

`kb.mjs` / `kb-index.mjs` 里的 `KB` 常量、`quote.mjs` 里的原文目录，都要改成你自己的。

## 依赖

- Node.js 18+
- Python 3.10+
- `pymupdf`（回原页核对时用）

## 精度声明

- `verify_text.py` 是**逐字比对**，不是相似度。差一个字就报错——这是故意的。
- 三态检查会拦下「记得有但没核对」的引用。它不会替你判断内容对不对，只判断「有没有证据」。
- 本仓不生产文献数据，只检查你已经有的。文献本身请用 [cite 工具](../) 或 DOI/Crossref 核。

## 姊妹仓

- [pdf-page-anchored-extraction](https://github.com/sjy888888/pdf-page-anchored-extraction) —— 带印刷页码的文本抽取
- [chinese-ocr-audit](https://github.com/sjy888888/chinese-ocr-audit) —— 中文 OCR 错字审计
- [marx-engels-historisch-kritische-gesamtausgabe-index](https://github.com/sjy888888/marx-engels-historisch-kritische-gesamtausgabe-index) —— 马克思恩格斯历史考证版卷目索引

## 许可

MIT
