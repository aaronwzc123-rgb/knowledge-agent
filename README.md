# 滔滔不绝

一个跑在自己电脑上的中文知识库 Agent。聊天、笔记、资料都留在本地，模型只在你主动发消息时才读到相关内容；知识库管理员把零散的 Markdown 整理成「能直接回答问题」的知识点和「说明它们之间关系」的主题导读，再用一张图谱把这些关系画出来。

![知识库目录](docs/screenshots/01-记忆目录.png)

## 这是什么

一个本机的小型 Web 应用，使用 Node、原生前端和 SQLite。基础功能无需构建或安装 npm 依赖。知识以 Markdown Wiki 保存，索引列出笔记，知识点回答问题，主题导读说明联系。整个库就是 `我的记忆库/` 文件夹，用 Obsidian 直接打开就能编辑。

![知识库：主题下的分类页](docs/screenshots/02-分类-知识与方法.png)

几个明确的取舍：

- **本地存储**：`data/*.sqlite` 存结构与来源，`我的记忆库/` 是纯 Markdown，随时能整份拷走、丢进 Git 或用 Obsidian 改。
- **写作约定**：知识点首段直接作答，正文用自己的话讲清楚前提和适用条件；主题导读用正文说明关系，再链到延伸问题。
- **可追溯**：整理时核对引用的连续原文，保留出处；正文保持连贯，不往段落里堆审核标签。

## 界面

### 知识库

左侧是主题与分类，右侧是笔记。每篇笔记都能在原文、Obsidian、下载之间切换，也可以「忘记」——从库里移除而不动磁盘上的原文件。

![笔记：一篇知识点的正文与来源](docs/screenshots/03-笔记-深度学习的基本原理.png)

### 图谱

每篇笔记是一个节点，每条引用是一条线：互相引用的笔记自然聚成一团，主题导读在团的中心。可以拖动节点、用「节点」滑块调大小、单击高亮一个笔记和它直接相连的邻居，也可以切到「只看双向」只看互相引用的那几条关系。双击节点直接打开笔记。

![图谱：118 篇笔记、154 条引用](docs/screenshots/06-知识图谱.png)

### Agent

在侧栏「Agent」选择助手即可查看八项 Harness 配置。点击右上角「编辑」才可以修改。每项需要单独保存。退出编辑会回到只读视图。保存后下一次调用会使用最新值。

![Agent 的八项 Harness 配置，默认以只读方式显示](docs/screenshots/07-agent-harness.png)

| 组件 | 保存后怎样生效 |
|---|---|
| 系统提示词 | 直接写回原来的 `我的记忆库/指导/*.md`。从 Obsidian 改同一个文件也能生效。 |
| 护栏 | 追加模型指令，可按词拦截请求，也能禁止联网搜索。 |
| 记忆 | 在长期记忆开启时，给这个 Agent 加入专属事实、背景或偏好。原有 Wiki 继续提供共享记忆。 |
| 工具说明 | 把对已有工具的说明带入模型请求。知识收录工具也会使用保存的说明作为工具描述。 |
| 子 Agent | 命中触发词时，将子任务交给选定的助手独立分析；收录转交会打开原有的管理员会话。 |
| Skills | 命中触发词时，把对应的 Markdown 工作步骤加入当前上下文。 |
| 脚本 | 命中触发词时，对问题或 Wiki 摘录运行确定性的文本指令，结果交给 Agent。 |
| 插件 | 在模型调用前补充指令，在工具调用前拦截，或在回复交付前处理文字。 |

除系统提示词外，其余配置保存在 `我的记忆库/指导/Harness/<agent-id>.json`。每项单独保存。若原文件已被另一个窗口或 Obsidian 更新，编辑器会提示冲突。脚本支持编辑器内列出的文本指令，插件使用预设的生命周期操作。资料摘要和知识库管理员依旧按各自固定的流程处理文件、校验引文和写入 Wiki。

<details>
<summary>查看系统提示词的编辑界面</summary>

![编辑系统提示词并写回 Obsidian Markdown](docs/screenshots/08-agent-edit.png)

</details>

## Agent 分工

| Agent | 做什么 | 权限 |
|---|---|---|
| 问答助手 | 先查本地 Wiki，能回答就直接复用；不联网 | 只读 |
| 滔滔 | 连续单口讲述，每段 250–350 字，可联网补料 | 只读 |
| 资料摘要助手 | 读取 PDF / Word / 图片，按页提取、分段摘要、给原文定位 | 只读 |
| Wiki 对照助手 | 用同一批 Wiki 笔记对照试跑提示词，积累通过对照的改进经验 | 只读 Wiki |
| 知识库管理员 | 专题研究、全库整理、知识点编辑、主题导读 | 授权后可写 |

对管理员说「整理整个知识库」。它会扫描记忆库里的 Markdown，跳过聊天原始档案、助手指导和系统索引，从新材料或有变更的页面开始整理：先拆出知识点，再把它们串成主题导读，最后写下每条结论引用了哪几段原文。普通 Agent 仍然只有读取和提交材料的权限。

开启「联网查询」和编辑权限后，发送 `@知识库管理员 专题研究：深度学习`。管理员会列出专题的问题，逐项复用本地笔记或检索公开原文，完成知识点后编写各专题导读并检查总导读的链接。若暂停、断线或网页暂时打不开，回到原对话点「继续」即可补做未完成的问题。

![专题研究的示例会话，显示待继续的问题和已整理的笔记](docs/screenshots/09-topic-research.png)

管理员的工作指导是记忆库里的 `指导/Wiki 编辑部.md`，改它就能改整理风格。

## 知识库怎么组织

知识点笔记回答一个问题，主题导读解释已有笔记之间的关系。例如《Sigmoid 是什么？》写定义和必要条件；《逻辑回归怎样从输入走到分类决定？》解释线性分数、概率与阈值，再链接到各自的知识点。两种笔记都能直接给读者看，写法与验收示例见《知识库收录规则.md》。

这些关系就是图谱里的那张图：引用是弹簧，把相关的笔记拉在一起；节点之间互相排斥，不同主题不会糊成一团；没有连线的孤点单独待着，不参与任何一块的聚拢。

## 怎么用

### 1. 启动

需要 **Node.js 22.13 或更新版本**（用到内置的 `node:sqlite`）。基础功能不需要 `npm install`。Harness² 原版和 Wiki 对照助手的 Python 环境见下文。

**Windows**：双击 `启动滔滔不绝.bat`，浏览器会自动打开 `http://127.0.0.1:8765`；用完双击 `关闭滔滔不绝.bat`。两个脚本共用 `launcher.mjs`，它负责找 Node、起服务、开浏览器，关闭时按端口停掉进程。

**macOS / Linux**：

```bash
node server.mjs --open
```

首次启动会自动建好 `data/` 和 `我的记忆库/`，包括助手指导、知识库准则、分类页和空目录。

### 2. 连上模型

打开左下角「设置」，填 DeepSeek API Key，点「连接」。Key 只用于当次请求，不写文件、不进数据库，重开页面要重新填。

同一个面板里还有：默认 Agent、联网查询、朗读回复、长期记忆开关；声音与语速；以及「管理员编辑权限」——不开这个，知识库管理员写不进任何东西。

### 3. 对话

输入框左边的 `@问答助手` 用来切换 Agent，也可以在输入框里打 `@` 选。点「资料」把资料库里的文件挂到这一轮对话上。回复可以朗读，播放时能暂停、继续。

### 4. 收材料、整理知识库

- 想让某份文档进知识库：把文件放进「资料库」，点开它做「提取」，再让摘要助手按页读；或者直接把 Markdown / 链接发给管理员。
- 想重整全库：打开「管理员编辑权限」，对管理员说「整理整个知识库」。它只处理新出现的和有改动的页面，写完后「整理记录」会列出这次写了哪几篇。

### 5. 看图谱

「图谱」页可以拖动、缩放、单击高亮、双击打开笔记。左边的分段按钮在「全部引用」和「只看双向」之间切换——后者只留下互相引用的关系，用来找真正的双向连接。「节点」滑块调圆圈大小，觉得挤就调小。「复位」重新取景，「刷新」拉一次最新数据。

### 6. 资料库

支持上传、新建文件夹、按类型/大小/更新时间查看。选中文件后可以提取文字（PDF、Word、图片 OCR）、生成摘要、复制引用（带文件名和页码，方便写笔记时标注出处）。提取结果按内容指纹缓存，原文件换了会重新提取，旧引用仍能打开当时的快照。

### 7. 备份与迁移

设置里的「备份」会把记忆库打包一份。更彻底的方式是直接拷走两个目录：`我的记忆库/`（全部 Markdown）和 `data/`（来源与索引）。换电脑时把它们放回原位，再启动一次即可。

## 使用 Google Harness² 原版

侧栏「Agent → Harness²」是 Google 上游命令入口。每行填一个参数，网页按原样交给官方命令。递归模式、试跑预算、OpenCode／Codex 执行器、基准和评测都由上游处理。安装使用 [Google Harness² 的固定提交](https://github.com/google-research/harness2/tree/6868817518876de8fd170c6a8354daca273b6191)。

![在网页运行 Google Harness² 官方本地演示](docs/screenshots/10-harness2-demo.png)

```bash
git clone https://github.com/google-research/harness2.git vendor/harness2
git -C vendor/harness2 checkout 6868817518876de8fd170c6a8354daca273b6191
```

也可以下载 [该版本的官方归档](https://github.com/google-research/harness2/archive/6868817518876de8fd170c6a8354daca273b6191.tar.gz)，把归档内的内容解压到 `vendor/harness2`。从 Linux 或 WSL 的项目根目录运行以下命令，需先安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)。

```bash
cd vendor/harness2
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e '.[render]'
```

使用官方模型桥接时，将安装选项改为 `.[render,bridge]`。

Windows 通过 WSL 启动，默认发行版是 `Ubuntu-24.04`。可通过 `TAOTAO_HARNESS2_WSL_DISTRO` 指定发行版，通过 `TAOTAO_HARNESS2_WSL_USER` 指定 Linux 用户，通过 `TAOTAO_HARNESS2_VENV` 指定其它 Linux 虚拟环境路径。

默认命令 `harness2-demo --output runs/demo --k 2` 在本地运行，无需模型凭证。结果默认写入 `vendor/harness2/runs/`。真实基准读取 `vendor/harness2/.env`，按选定的模型和执行器配置凭证及安装基准依赖。点「参数帮助」可以查看命令的完整参数。需要同时运行模型桥接和基准时，可以分别在两个页面里操作。[上游配置说明](https://github.com/google-research/harness2/blob/main/docs/SETUP.md)

### Wiki 对照助手

「Wiki 对照助手」沿用滔滔不绝的 DeepSeek 连接和 Obsidian Wiki。它调用上游调度器做一轮顺序递归，在相同的 Wiki 摘录上对照系统提示词，随后选择基准回答或改进后的回答。开启长期记忆时，采纳的提示词和改进经验写到 `data/harness2/`，供后续试跑参考。

源码同样放在 `vendor/harness2`，运行需要本机 Python 3.12 或 3.13。可以通过 `TAOTAO_HARNESS_PYTHON` 指定解释器。它的基础提示词保存在 `我的记忆库/指导/Harness².md`。

## 自己加一个 Agent

一个 Agent 就是 `agents.mjs` 里的一段配置。没有注册表、没有路由、不用改 CSS 和 HTML——加完重启一次，它就出现在侧栏、`@` 选择器和设置里。

以加一个「翻译助手」为例，在 `export const AGENTS = Object.freeze({` 里复制一段现有配置改成这样：

```js
  translator: Object.freeze({
    id: 'translator', name: '翻译助手', guidance: '指导/翻译助手.md',
    continuous: false, webSearch: false,
    aliases: ['翻译', '译者'],
    maxTokens: 3000, temperature: 0.3,
    system: '你是翻译助手。先确认目标语言和用途，再逐段翻译：保留专有名词、数字和格式，术语前后一致；不确定的译法标注原文，不要自行增删内容。只输出译文，除非用户要求解释。',
  }),
```

四步就能用起来：

1. **复制一段配置改字段**。`id` 要唯一、不带空格；`guidance` 指向 `指导/<你的名字>.md`，文件现在不用建。
2. **重启一次**（关掉再开 `启动滔滔不绝.bat`，或重新 `node server.mjs`）。首次启动会自动生成 `我的记忆库/指导/翻译助手.md`，内容是上面 `system` 的原文。
3. **日常调整从 Agent 页进入「编辑」**。系统提示词也可以在对应的 Markdown 里直接改，下一次调用就会生效。
4. **刷新页面**，侧栏「Agent」、输入框的 `@` 菜单、设置里的下拉都会多出它。

字段说明：

| 字段 | 作用 |
|---|---|
| `id` | 唯一标识，会写进每条会话记录。改 id 等于换了个人，旧对话不会跟过去 |
| `name` | 界面显示名，也是 `@名字` 的默认叫法 |
| `guidance` | 指导文件相对路径。文件不存在时才用 `system`，所以 `system` 要写成一份能独立工作的完整提示词 |
| `continuous` | `true` 是连续讲述（像滔滔，说完一段自动接下一段）；`false` 是一问一答 |
| `webSearch` | 默认是否允许联网；用户仍可在设置里单独开关 |
| `aliases` | 额外可 `@` 的名字，中英文都行 |
| `maxTokens` / `temperature` | 单次生成长度与随机性；整理类任务用低温度 |
| `researchInstruction` | 首次生成配置时填入联网工具的默认说明，可省略。之后从 Agent 页修改。 |

需要特殊能力时，才需要动 `server.mjs`：知识库管理员写入知识库、资料摘要助手解析文档，都是在对话分支里按 `agent.id` 接了一段逻辑（搜 `agent.id === 'librarian'` 和 `agent.id === 'summarizer'` 就能看到）。普通 Agent 走通用分支，自动带上本地记忆检索、联网和朗读，不需要写任何服务端代码。

两个容易踩的点：

- **指导文件存在 `我的记忆库/` 里，不在版本控制里**。你 fork 出去分享时，别人拿到的是代码里的 `system` 默认值——所以想分享的 Agent，把完整提示词写进 `system`，别只写在 md 里。
- **写入知识库的权限只发给 `librarian`**。新建的 Agent 默认只读，即使它自己想写也写不进去；这是有意为之，避免一个没调好的提示词改坏笔记。

## 资料提取（可选）

纯聊天和知识整理不需要这些。只有「资料库」里的本地文件解析需要：

- **PDF**：Python 3 + `pip install pypdf pypdfium2`；可以用 `TAOTAO_PYTHON` 指定解释器。
- **.doc**：在 `tools/document-extract` 里跑一次 `npm install`（`word-extractor`）。
- **图片文字**：使用 Windows 自带 OCR，仅 Windows 可用；缺少语言包时会在提取结果里说明。

## 目录结构

```
server.mjs            本地 HTTP 服务与接口
agents.mjs            Agent 定义：名称、别名、温度、长度、是否连续、是否联网
agent-harness.mjs     Agent 配置读写和运行时
agent-editor.js       Agent 的 Harness 界面
harness2-upstream.*  Google Harness² 官方命令入口
harness2-worker.py   Wiki 对照助手的本地适配
wiki-librarian.mjs    知识库管理员：问答、收录、全库整理的入口
wiki-topic-research.mjs 专题研究和断点续做
wiki-organizer*.mjs   知识点编辑、目录编辑和安全写入
knowledge-policy.mjs  四类知识的判定规则与程序校验
memory.mjs            SQLite + Obsidian 双存储、目录与分类页生成
resource-extract.*    PDF / Word / 图片提取（Python 与 Word 解析）
app.js / style.css    前端
graph.js              知识图谱：力导向布局、拖动与高亮
launcher.mjs          启动与关闭（找 Node、起服务、开浏览器、按端口停进程）
启动滔滔不绝.bat       Windows 入口
data/                 运行时数据库（不入库）
我的记忆库/            Obsidian 库：raw 原始档案 + wiki 笔记 + 指导与准则（不入库）
```

## 数据与隐私

- 笔记保存在本机。运行全库整理时，相关 Markdown 内容会分批送给你连接的模型；整理之前请确认模型可以阅读这些材料。
- 聊天记录、笔记、资料库、备份和 Harness² 的依赖、凭证及运行结果保存在本机，相关路径见 `.gitignore`。
- Wiki 页面、原始档案和网页里的指令都按数据处理，不会改变助手的行为或授予权限。
