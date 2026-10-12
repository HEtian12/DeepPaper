# 本地工程验收记录

日期：2026-10-12。功能基线提交：`930ecf3`；构建修复提交：`6827ba3`。本记录描述开发机验证，尚不代表 GitHub Actions、干净机器或真实模型服务已经验收。

## 环境与结果

| 项目 | 结果 |
| --- | --- |
| 系统 / Node | Windows 10 / Node.js 22.22.2 |
| Electron / electron-builder | 33.4.11 / 26.8.1，版本与锁文件一致 |
| `npm test` | 通过：语法及 PDF、全库检索、RAG、向量缓存辅助函数和 Agent 工具检查 |
| `npm run smoke:pdf-reader` | 通过：隔离 Electron 用户目录、合成 PDF、本地 mock Embedding 服务 |
| 打包脚本语法 | `node --check scripts/build-portable.js` 通过 |
| Windows portable 构建 | 压缩级别 1 下成功生成 EXE |
| ASAR 内容 | 确认包含 Agent、RAG、向量模块、Electron 主进程及版权声明；包版本为 0.1.48 |

文档本地链接和 CI YAML 已在本地解析检查。源码中未匹配到扫描覆盖的常见 Key/私钥格式；这只是模式检查，不是完整安全审计。

## 打包问题与修复

同一份解包应用包含 78 个文件、388,515,189 字节。7-Zip 21.07 在级别 9 和 5 下均返回 `Can't allocate required memory`，级别 1 压缩通过，随后完整 portable 构建通过。

`scripts/build-portable.js` 将默认等级设为 1，允许 `ELECTRON_BUILDER_COMPRESSION_LEVEL` 覆盖。这个问题依赖构建时可用内存，使用真实打包命令回归验证，没有用模拟内存不足的单元测试代替。

本次 EXE 为 123,277,124 字节，保存在本地忽略目录 `artifacts/portfolio-build-fixed/DeepPaper 0.1.48.exe`，不随 Git 文档提交。

```text
SHA-256: d07823cf9f57678205fd500b7d3e523bf1a18ab961d2d5a598e731ab90b55cc9
```

## 尚未验证

- GitHub Actions 云端运行及干净环境中的安装包行为。
- 真实模型端到端 Agent 任务成功率和回答证据支持率。
- 真实文献数据上的 Recall、MRR、页码命中率及检索延迟。
- 全界面回归、所有 PDF 版式，以及较大文献库的资源上限。

当前演示截图是测试环境截图；真实研究任务视频与质量评测属于下一阶段。
