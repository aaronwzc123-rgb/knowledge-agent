# 本地文档解析

`resource-extract.mjs` 读取原文件，提取过程中不调用云服务，也不启动 Office 或执行文档宏。

- PDF 使用本机 Python 的 `pypdf` 提取文字，按页定位；无文本或疑似乱码页面由 `pypdfium2` 本地渲染后交给 Windows OCR。
- DOCX 直接解析正文 XML，按标题、段落和表格定位，不生成虚构页码。
- DOC 使用这里安装的 MIT 许可 `word-extractor@1.0.4` 解析，不需要 Office。
- 图片使用 Windows 自带 OCR，需系统已安装可用的 OCR 语言包。本机已有简体中文包。
- TXT/Markdown 等文本直接读取，支持 UTF-8 与带 BOM 的 UTF-16。

Python 优先使用 `TAOTAO_PYTHON`，其次查找当前 Node 所属 Codex 安装包自带 Python及本机常规 Python 目录。PDF 需要 `pypdf` 和 `pypdfium2`；DOCX 只使用 Python 标准库。本机 Codex 运行时已提供所需组件。迁移到另一台机器时，可安装 Python 后执行 `python -m pip install pypdf pypdfium2`，并将 `TAOTAO_PYTHON` 指向该 Python。

每次最多提取 200 页/段、100 万字符，OCR 最多 30 页；达到限制、识别错误或未处理内容会返回明确警告。原文不会被修改。

`fixtures/sample.doc` 来自 [node-word-extractor 的 test01.doc](https://github.com/morungos/node-word-extractor/blob/main/__tests__/data/test01.doc)，仅作为解析回归样本，遵循上游 MIT 许可。

依赖版本锁定在 `pnpm-lock.yaml`。恢复依赖可在此目录运行 `pnpm install --frozen-lockfile --ignore-scripts`。
