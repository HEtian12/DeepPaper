# RAG 评测计划

状态：离线评测程序、三路检索入口、合成样例与缓存向量生成命令已实现。私人工作区现有 44 道真实文献问题草稿（38 道有答案、6 道暂定无答案），证据和答案充分性仍待人工复核；它们不是已验证的质量基准。公共仓库不包含 `evaluation/local/` 中的论文全文、问题和报告。合成样例仅验证评测程序，不能当作论文检索成绩。

## 运行现有评测工具

```bash
npm run eval:rag -- demo --out artifacts/rag-eval-demo
```

生成 `corpus.json`、`questions.json`、`vectors.json`、`report.json` 和 `report.md`。合成向量仅由关键词规则生成，用于验证三路流程，不是 Embedding 模型输出。

用软件左上角“导出库”得到 JSON 后，在本机生成只保留评测所需字段的论文库和空白标注模板：

```bash
npm run eval:rag -- import --library <文献库导出.json> --out evaluation/local
```

若导出缺少页码映射且原 PDF 仍在本机，把 `--rebuild-pages` 加到这条命令末尾。

导入器只接收有全文和精确 `pageTextOffsets` 的 PDF 论文。旧导出若缺少页码映射，但原 PDF 路径仍可访问，可以添加 `--rebuild-pages`，在本机逐页重新提取正文及页码；扫描版 PDF 无可提取文本时会跳过。这个操作只读原 PDF，不调用外部服务。导入还生成 `corpus-audit.json`（空页/短页统计）和 `annotation-candidates.json`（每篇论文的原文摘录，供人工选题）。PDF 字体或字符映射警告可能造成局部提取缺陷，标注前须在原 PDF 核实。`evaluation/local/` 已加入 `.gitignore`，原始 PDF 路径、Key、图片、任务历史及合集不会写入生成的评测库。生成的 `corpus.json` 仍包含论文全文，必须留在私人目录。

在 `evaluation/local/questions.template.json` 中填入真实问题与原文证据并另存为 `questions.json`。顶层 `annotationStatus` 初始为 `draft`，每条都由人工核对 PDF 后才改为 `verified`。每个问题包含 `id`、`query`、`type`、`split`（`development` 或 `test`）、`answerable`、`reviewedBy`、`notes`、`evidence`。每条证据包含稳定 `id`、`paperId`、原始 PDF 的 `pageNumber`、页上逐字 `quote` 和相关性等级 `relevance`（1 或 2）。无答案问题设 `answerable: false` 且 `evidence: []`。标注示例可在合成样例的 `questions.json` 中查看。`draft` 报告会明确标成未验证，不能作为简历质量指标。

先跑关键词基线：

```bash
npm run eval:rag -- run --corpus evaluation/local/corpus.json --questions evaluation/local/questions.json --mode keyword --split development --k 5 --out evaluation/local/keyword
```

向量和混合检索需要和这次切片配置对应的文本向量。先导出**全部问题**及切片的待向量化文本：

```bash
npm run eval:rag -- inputs --corpus evaluation/local/corpus.json --questions evaluation/local/questions.json --split all --out evaluation/local
```

`embedding-inputs.json` 包含精确文本和 SHA-256，可用已有服务按自己的预算生成 `vectors.json`。也可显式运行下面的 API 命令；Key 只从环境变量 `DEEPPAPER_EVAL_EMBEDDING_KEY` 读取，命令参数不接收 Key。`--max-inputs` 是**本次最多发送的文本条数**，支持重复执行续跑；多模态地址使用 `--batch 1`。运行前确认模型已开通及计费方式。

```bash
npm run eval:rag -- embed --inputs evaluation/local/embedding-inputs.json --out evaluation/local --endpoint <Embedding-API地址> --model <模型名> --provider <服务商> --revision <模型版本或Endpoint版本> --kind real --max-inputs 20 --batch 1
```

向量生成期间的已完成批次追加到 `vectors.ndjson`，中断后可以用相同命令续跑；全部文本齐备后才生成 `vectors.json`。向量全部生成后，固定同一套库、问题、Top-K 和切片配置运行三路比较：

```bash
npm run eval:rag -- run --corpus evaluation/local/corpus.json --questions evaluation/local/questions.json --vectors evaluation/local/vectors.json --mode all --split test --k 5 --out evaluation/local/test
```

`--target` 默认 820 字符，`--overlap` 默认 120 字符，`--cleaning on|off` 默认开启；每次改变它们都要重新执行 `inputs` 并补齐新切片的向量。`--repeats` 默认 5 次，另有每问题每模式 1 次预热。`report.md` 用于阅读，`report.json` 保留排名、全文片段、每次耗时、输入哈希和环境信息。它们可能包含私人论文内容，不要直接上传。

评测不会静默把缺失向量的混合检索降级为关键词检索；若向量与文本哈希或维度不符会报错。离线检索过程不发网络请求。生成向量时才调用指定服务，已完成的批次写入本地缓存。

## 下一阶段的最小交付

建立 30-50 个问题的人工标注小型数据集，覆盖中英文查询、术语改写、两个概念同时命中、跨论文比较，以及库内没有答案的情况。每条记录应包含：

- 问题 ID、查询文本、问题类型；
- 相关论文 ID、原始 PDF 页码、支持答案的原文片段；
- 相关性等级及人工标注说明；
- `development` 或 `test` 划分。

金标准用稳定的论文/页码/原文锚点保存，运行时映射到当前切片，避免更换 Chunk 大小后旧 passage ID 失效。一个问题允许有多个正确证据，不把某一次系统返回结果当成金标准。

公开数据仅使用具备分发许可的文本；个人论文库留在本地。记录数据来源及使用条件，公共仓库可以提供合成样例用于验证评测程序，但不能用合成样例指标宣称真实文献效果。

## 对比设置

在相同文献库、问题集和 Top-K 设置下比较：

1. 当前关键词检索基线；不能将它称为 BM25，当前实现是自定义打分。
2. 纯向量余弦检索。
3. 当前关键词与向量排名融合。

评测入口应支持各路径采用相同候选和返回数量，记录现有 Top-K 与单篇上限。逐项对比清洗开关、overlap、Chunk 大小；在 development 集确定配置，再用固定 test 集报告结果。

## 指标定义

| 指标 | 计算和用途 |
| --- | --- |
| Passage Recall@K / Passage MRR@K | 严格单段落口径：完整归一化证据必须出现在一个 Top-K 检索 Chunk 内；MRR 取第一个完整命中段落的排名倒数。 |
| Context Recall@K / Context MRR@K | Agent 阅读口径：对每个 Top-K 命中段落，按实际 `read_passages` 行为合并同一论文、同一原始页码内前后各一个相邻 Chunk，再核验完整证据；MRR 取第一个能在该上下文中复原证据的命中排名。不能跨页拼接。 |
| 页码召回率 | 返回结果匹配标注论文及原始 PDF 页码的比例，按问题宏平均；精确页码与估算页码的数字吻合单独统计，后者不能证明真实页码正确 |
| 无答案返回非空率 | 只测“返回了邻居段落”，不是“声称有充分证据”；尚未实现回答层无答案误判率，因此报告该项为 `null` |
| 延迟与内存 | 当前记录预热后的本机检索 p50/p95、索引构建与向量校验耗时、报告时 RSS；尚未测进程峰值内存或模型回答耗时 |
| API 用量 | `embed` 命令记录实际请求次数及服务商返回的 token 用量；服务商未返回时统计值为零但不表示免费，报告不计算金额 |

有答案问题分别计算 Passage 与 Context 的 Recall/MRR，无答案问题单独统计，不把没有相关证据的问题当作 Recall 的零分样本。报告同时列出严格段落漏项、上下文漏项，以及分别在单 Chunk/Agent 上下文中无法映射的证据锚点。Context 指标更贴近 Agent 实际读取证据的流程，但不能代替严格 Passage 指标。检索指标和生成回答的证据支持率分别报告；模型自评需要人工抽检。

关键词检索使用自定义加权，不是标准 BM25。当前开发试验包含中文标题/关键词 n-gram 匹配、混合语言缩写抽取和基于语料文档频率的词项加权；开发集上的结果仅用于选方向。测试划分已用于早期探索性诊断，后续报告必须显式标明这一点，不能再把它描述为未触碰的独立测试集。

## 可复现报告

报告需要附 Git commit、数据集版本、清洗和切片设置、Embedding 模型与版本、向量维度、库内论文/Chunk 数量、Node/系统/硬件信息、冷热缓存条件和运行次数。扩大数据量时标记合成压力数据与真实文献的区别。

目标不是预先设定“提升 XX%”，而是保存可复查的原始结果和失败案例，在真实测量后填写简历指标。
