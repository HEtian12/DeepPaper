# 开发、验证与发布

## 环境

- Windows 为当前桌面运行及打包的验证目标。
- 使用 `.nvmrc` 指定的 Node.js 22.22.2 和随附 npm。冒烟测试使用 Node 内置 `fetch` 和 `WebSocket`，不使用系统浏览器。
- 首次 `npm ci` 需要下载依赖及 Electron；安装后，自动检查和 mock 集成测试不需要真实模型服务或 API Key。

```bash
npm ci
npm test
npm start
```

`npm ci` 使用锁文件固定依赖。只有主动变更依赖时才更新 `package-lock.json`。

## 验证范围

| 命令 | 验证内容 | 不证明什么 |
| --- | --- | --- |
| `npm test` / `npm run check` | JS 语法、加载关系和固定样例断言，含关键词、清洗、页码、向量及本地工具 | 真实论文检索质量或真实模型效果 |
| `npm run test:e2e` / `npm run smoke:pdf-reader` | 启动 Electron；生成小型 PDF；验证文本层、关键词编辑、RAG/IndexedDB、Embedding IPC 重试、历史语料持久化和原文回跳 | 全部交互路径、真实模型任务成功率、所有 PDF 版式 |
| `npm run dist -- --publish never` | 生成 Windows portable EXE | 安装包在干净机器上的完整验证 |

冒烟测试使用临时 `--user-data-dir`，不读取日常文献库。Embedding 请求连接 `127.0.0.1` 的测试服务，向量是合成数据。测试结束关闭 Electron 并尝试清理临时目录。

默认截图保存于系统临时目录的 `deeppaper-ui-qa`。PowerShell 中可将截图放到仓库的忽略目录：

```powershell
$env:DEEPPAPER_SMOKE_SCREENSHOT_DIR = "artifacts/screenshots"
npm run test:e2e
```

测试会尝试随机选择本地端口；如启动失败，先检查 Electron 是否安装完整、测试端口是否被占用，以及 Node 版本是否满足要求。

## GitHub Actions

[CI 工作流](../.github/workflows/ci.yml) 在 main 推送、Pull Request 和手动触发时运行：

1. Ubuntu 和 Windows 上安装锁定依赖并运行 `npm test`。
2. Windows 上运行 Electron 集成冒烟，上传已有测试截图，保留 7 天。
3. 仅手动触发时生成 portable EXE 并保存为构建产物，保留 7 天。

工作流不需要厂商密钥，不会自动创建 GitHub Release。云端执行结果以 Actions 页面为准；本地测试通过不等同于云端已通过。

## 版本与发布

当前源码版本为 `0.1.48`。历史 GitHub Release 不一定包含当前源码的全部功能；发布前应先确认对应 commit。

1. 整理改动、运行上述检查和集成测试。
2. 在明确发布范围后，同步调整包版本及锁文件版本，填写 `CHANGELOG.md`；不要为整理文档虚构历史发布日期。
3. 打包，使用独立测试资料检查启动、导入、阅读、关键词编辑、导出/导入和退出后恢复。
4. AI/Embedding 另做小规模真实接口验证并记录模型、数据规模及费用；mock 测试不能替代这一步。
5. 提交通过验证的源码，再关联 tag 和 Release；分发 EXE，不上传个人文献库、API 配置或开发机用户目录。

当前 portable 包没有代码签名。依赖升级、签名和干净环境验收需单独验证。

`npm run dist` 通过 `scripts/build-portable.js` 启动构建，默认使用 7-Zip 压缩级别 1。当前机器上同一份应用文件使用级别 9/5 时出现内存分配失败，级别 1 压缩通过；取舍是更大的包体。可以通过 `ELECTRON_BUILDER_COMPRESSION_LEVEL` 覆盖默认值；重新采用较高等级前应验证构建内存。

## 改动约定

- 业务修改保持模块边界；不要在同一次改动中顺带替换前端框架或数据库。
- 回归用例关注用户行为或真实故障，避免只检查源代码中出现某个字符串。
- 不提交密钥、私人 PDF、导出文献库或本地模型权重。
- 修改存储结构时考虑旧库兼容、迁移及备份；真实用户数据不作为测试夹具。

下一阶段的检索质量评测见 [评测计划](evaluation.md)。
