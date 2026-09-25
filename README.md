# dsh-prompt-manager-ja（日本語版）

[@lolkda/dsh-prompt-manager](https://github.com/lolkda/dsh-prompt-manager) v3.4.0-rc.2 の日本語ローカライズ fork です。本家の i18n 非対応（UI 文字列の中国語ハードコードのみ）のため、クライアント UI およびサーバ側メッセージを日本語に翻訳しています。コードの振る舞いは本家と同一で、`id: prompt-manager` の Loader entry / 設定名前空間 / データディレクトリもそのまま引き継ぎます。

- インストール: `dsh plugin --profile web add github:motchii709/dsh-prompt-manager-ja`
- 本家への追従: upstream を merge したあと、再度翻訳を再適用してください（翻訳スクリプトは同梱していません。`tools/` は本家のままです）。
- ライセンス: MIT（本家に準じます）

---

# dsh-prompt-manager

## 3.4.0-rc.2：修掉启动竞态下丢失的设置命名空间

`3.4.0-rc.1` 把索引改成 Loader entry 上的 volatile `Config` 字段，但那个 schema 是在模块求值时用**同步 `require('@deepseek-ai/schemastery')`** 拿工厂再构建的。0.1.7-rc.1 的 Loader 会并发 import 整个 Profile 的条目，同步 require 撞上「正在加载的 ESM-only 依赖（cosmokit）」时 Node 抛 `ERR_REQUIRE_ESM_RACE_CONDITION`，而当时的 `catch` 把它静默吞掉 —— 于是 `Config` 变成 `undefined`，这个 entry 在宿主眼里没有 schema，`dsh-settings` 直接跳过它：**设置命名空间从不对外服务**。表现出来就是输入框旁两个芯片消失、新增/订阅都报「宿主没有接受这次保存」，而已有订阅索引滞留在 `settings.yaml.imported` 里读不出来；插件自身的 HTTP 路由一切正常，所以看起来"没报错但什么都不工作"。

本版把工厂改为经 ESM 图解析（顶层 `await import('@deepseek-ai/schemastery')`），不再与加载器抢同一条同步路径；解析失败时改为在挂载时通过 `ctx.logger.warn` 说明原因，不再静默。`test/config-schema.mjs` 注入加载器那条真实错误做回归，`tools/check-boot-acceptance.mjs` 对真实冷启动验收。

升级后请**重启 dsh 进程**（`Config` 在模块求值时定死，刷新页面无效），并把 `settings.yaml.imported` 里旧的 `prompt-manager:` 段重新导回（在「设置 → 提示词 → 来源」重新添加来源并应用即可，本地快照仍在）。

## 3.4.0-rc.1：DSH 0.1.7-rc.1 本地适配

本版使用原生 `Config`/volatile 与 `configForms`，不修改 DSH 核心。Loader entry id 保持 `prompt-manager`，旧同名 `settings.yaml` 段由 DSH 自动导入 Profile patch，原文件保留为 `.imported`；正文、脚本、订阅与每会话选择的数据目录不变。设置被宿主拒绝时明确显示失败，正文已保存而索引失败时保持可重试，不误报成功。下文旧版本迁移章节中的旧 Settings API 与存储路径仅说明历史版本。

[![ci](https://github.com/lolkda/dsh-prompt-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/lolkda/dsh-prompt-manager/actions/workflows/ci.yml)

把提示词作为 **system prompt section** 注入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH），并在 Web GUI 的 **设置 → 提示词** 里管理它们：开关、排序、新增、删除、改正文（markdown）。

正文里可以引用 `{{变量}}`：插件提供机器事实、配置值、探测结果和脚本变量；DSH 原生提供当前 agent / 会话的 `{{cwd}}`、`{{model}}`、`{{provider}}`。原生变量列在目录中，但不由本插件重复注册，也不作为全局固定值。

除了 system prompt，这个插件还能替换 **DSH 压缩上下文时发给摘要模型的那条指令**（原本写死在 `dsh-compaction-basic` 里）—— 见「压缩指令」一节。

| 部分 | 存在哪 | 谁在改 |
|---|---|---|
| 索引（标题 / 顺序 / 开关） | 当前 Profile patch 中 `id: prompt-manager` 的 volatile `config` | 设置页，或编辑 Profile 配置 |
| 组合（只挑普通提示词成员） | 同一段里的 `presets` | 设置页的「组合」页 |
| **哪个组合 / 哪条压缩指令生效** | `$DSH_HOME/prompt-manager/sessions/<会话 id>.json` | **每个会话各记各的**：会话输入框那一行的「提示词」/「压缩」芯片 |
| 正文（markdown） | `$DSH_HOME/prompt-manager/sections/<id>.md` | 设置页，或任意编辑器 |
| 变量脚本 | `$DSH_HOME/prompt-manager/scripts/<name>.js` | 设置页的「变量」页，或任意编辑器 |

上面那张表里只有第三行是**按会话**的，其余都是全机一份：有哪些提示词、正文、组合的定义（成员清单）、订阅来源、镜像/代理都是目录类东西，换哪个会话看都一样；而"现在用哪套"是对话自己的事。所以 A 会话切一下，B 会话不会跟着变 —— 见「每会话选择」一节。

插件只内置一条提示词：机器环境（系统 / shell / 工具链版本在挂载时探测填充；工作目录 `{{cwd}}`、模型 `{{model}}` 和提供方 `{{provider}}` 在每次组装时按当前 agent / 会话解析）。其余自己写，或从可订阅的仓库拉。一份现成的提示词包在 [lolkda/dsh-prompt-pack](https://github.com/lolkda/dsh-prompt-pack)（CTF 作业契约 + FastCtx 工具路由）。

## 安装

三种装法，选一种。`lib/`、`client/`、`environment.md` 都随包发布，所以装完不需要本地工具链。

### 方式 A：`dsh plugin` 一条命令（推荐）

```bash
dsh plugin --profile web add github:lolkda/dsh-prompt-manager
```

这个命令把剩下的参数转给 profile 目录里的 pnpm，装完 DSH 会发现这个包的清单里声明了 `dsh.bundle.patch`，**自动把它加进 `dsh.profile.bundles`** 并应用包内那份 `cordis.patch.yml` —— profile 自己的 `cordis.patch.yml` 一个字都不用写。装完重启一次 profile。

发布到 npm 的同一条命令（`@lolkda/dsh-prompt-manager` 已上架）：

```bash
dsh plugin --profile web add @lolkda/dsh-prompt-manager
```

`latest` 停在最后一个稳定版（面向 DSH 0.1.6）。面向 DSH 0.1.7-rc.1 的 `3.4.0-rc.x` 按预发布标签发布，装它要显式点名 `@next`：

```bash
dsh plugin --profile web add @lolkda/dsh-prompt-manager@next
```

### 方式 B：相对路径挂载（离线 / 开发用，不装包）

```bash
git clone https://github.com/lolkda/dsh-prompt-manager "$DSH_HOME/profiles/web/vendor/dsh-prompt-manager"
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: prompt-manager
      name: './vendor/dsh-prompt-manager/lib/index.js'
```

loader 用 `new URL(name, ctx.baseUrl)` 解析前导 `./`，而 `ctx.baseUrl` 就是 profile 目录，所以这个路径指向 `$DSH_HOME/profiles/web/vendor/dsh-prompt-manager/lib/index.js`。

**两种方式二选一**：既装包又留这一行，插件会被挂载两次。不写 `config` 也可以 —— `environment` 默认就是开的，要关就在你自己的 patch 层里覆盖。

### 卸载

```bash
dsh plugin --profile web remove @lolkda/dsh-prompt-manager
```

删掉依赖后，DSH 下次启动会把它的层从 `dsh.profile.bundles` 里摘掉，重启 profile 生效。手写挂载（方式 B）删掉那一行、再删 vendor 目录即可。删包不动你的条目：正文在 `$DSH_HOME/prompt-manager/`，索引在 settings 里，都不属于这个包。

### 装完怎么确认

```bash
dsh --profile web --dump-config        # 组合出来的树里应该有一行 id: prompt-manager
curl -s http://127.0.0.1:3080/dsh-prompt-manager/status | head -c 200
```

再打开 **设置 → 提示词**，列表里应该有你已有的条目（或内置的「本机环境」那条）。

## 这个包读写什么、会起什么进程

按 DSH STORE 的四项访问轴逐项说明。汇总权限等级是 **`high`** —— 按商店的定义，"可访问任意网络、任意 Shell"即属此级，本插件两条都沾（下详）；这不是自谦也不是自夸，是照它的判定口径填的。**本插件不访问任何凭据**，理由见「凭据」一条。

- **文件（`files`）**：索引与组合由原生 Config/Settings 读写当前 Profile patch 中 `prompt-manager` entry 的配置；旧 `settings.yaml` 仅在 DSH 迁移时导入。正文、脚本、订阅快照保留在已配置的 storeDir（默认 `$DSH_HOME/prompt-manager/`），先写临时文件再 `rename`。不读环境变量敏感项，不读写 DSH 的会话日志。
- **网络（`network`）**：只有订阅源会出网（`fetch` 拉 `prompt-manager.json` 与正文，可配 https 镜像）。探测命令与变量脚本可能自行出网，那是**你配置的命令**在做，不是插件在做。不开监听端口，不做任何回连或遥测。
- **命令（`commands`）**：按你 settings 里的配置跑**探测命令**（默认 `pwsh`/`bash`/`git`/`node`/`python`，挂载时各跑一次）和**变量脚本**（`node <脚本文件>`，保存时 / 挂载时 / 你点「重新测量」时各跑一次）。命令、参数、脚本全部来自这份配置，**插件自己不带任何可执行文件**；删掉配置就没有任何进程被起。它们以 DSH 进程的权限运行，你怎么审自己写的脚本，就怎么审这里的配置。
- **凭据（`credentials`）**：**不读取、不存储、不转发任何凭据。** 具体地：不读环境变量里的 token/key、不读 git 凭据助手、不读 `~/.npmrc` 之类凭据文件、不发带认证头的请求。仓库里出现 `token`/`credential`/`password` 字样的地方只有两类，都不是凭据访问：`client/client.js` 里的 "token" 指**变量占位符**（`{{名字}}` 这种东西，与 React 的 key）和 README 发布章节里"**不放**任何 npm token（改走 OIDC）"的说明；`src/source.ts` 与 `src/routes.ts` 各有一处**守卫**，作用是**拒绝**带凭据的镜像 URL（`url.username`/`url.password` 非空即报错）。换句话说，凭据相关代码在这里是**拒收**逻辑，不是采集逻辑。
- **改请求**：只碰**压缩**那一次调用（见「压缩指令」一节）。监听 `llm/stream`，只在 `purpose === 'compaction'` 时把最后那条指令消息换成本插件里配置的正文；**普通对话请求一个字节都不动**。没配压缩指令时不注册任何替换动作。可以整体关掉：`compaction: false`。
- **HTTP**：注册一条 `/dsh-prompt-manager` 前缀路由。**本机对端**（`127.0.0.0/8` / `::1`）照旧免会话可用，但 `Host` 头必须是本机名（挡 DNS rebinding）；**其它对端不由插件自己判**，交给宿主已有的浏览器信任 —— 就是 `/api` 用的那把尺子（loopback，或部署信任的 Host + 签名浏览器会话）。写操作一律再加 same-origin。端点清单见 `src/routes.ts`。**它不是认证**：本机其它进程照样能调；边界是"别家网页进不来"，单用户工作机上够用。
- **生命周期脚本**：**没有** `preinstall`/`install`/`postinstall`/`prepare` 任何一项（`npm install` 不构建、git 安装也不构建，因为 `lib/`、`client/` 就是提交进仓库的构建产物）；只有 `prepublishOnly`，它只在**作者**执行 `npm publish` 时跑，装包的人永远不会触发。
- **外部运行依赖**：无。`dependencies` 为空，运行期只用 DSH 自己提供的服务（`systemPrompt`、`settingsScope`、`llm`）与 Node 内置模块；`lib/` 与 `client/` 都是自洽产物。
- **已知风险**（照实说，不粉饰）：
  - 那条路由**不是认证**：本机任意进程都能调它读写你的提示词索引 —— 单用户工作机上够用，多用户/共享机器上不够。**部署把面板开到局域网时，这条路由跟着开**：能拿到浏览器会话的页面也能调它，和那个页面本来就能调 `/api`（改设置、跑会话、切权限）是同一件事，插件不额外加宽，也不额外收窄。
  - 探测命令与变量脚本**以 DSH 的权限执行**，能力上限等于你给 DSH 的权限；恶意或手误的脚本能做的事，插件拦不住。
  - 订阅来的正文会**注入 system prompt**，等于让第三方仓库的内容进入你的模型上下文；只订阅你信得过的仓库，应用前先看 diff（来源页会列出变更文件与增删行数）。
  - 订阅条目默认只读，但**「fork 成本地条目」之后就是本地正文**，之后它的内容与来源仓库不再有关系。

## 设置页

**设置 → 提示词**（order 60，排在 General / Models / Plugins / Agent presets / 市场之后）：

- **列表**：三个 tab（全部 / 本地 / 订阅）分层；一行 = 标题 + 注入开关 + 右侧「⋯」菜单（编辑 / 删除）。订阅条目带「订阅」徽标，其中的 `owner/repo` 是指向上游仓库的真链接。**压缩指令那一行没有开关** —— 它的 `enabled` 不决定任何事，能决定它的选择按会话各记各的，所以那行只标一句「每会话自选」。底部是「新增提示词」「新增压缩指令」「订阅来源（N）」「变量（N）」「组合（N）」—— 固定两列一行，奇数个时最后一个占满整行，所以这一行不会随面板宽几个像素而变形。条目数到上限时「新增」直接拒绝并说明原因。标题下面那行说明末尾是插件自己的仓库链接和一句点星请求。
- **这一页不报"哪个组合 / 哪条压缩指令正在生效"**：那是每个会话自己的事实，页面上无法得知，所以它只报压缩的**全机计数器**（已替换 N 次 / 已见到 N 次压缩 / 最近一次时间），以及"哪个组合生效由每个会话自己决定"这句话。
- **编辑器**：标题、顺序、只读 id、Markdown 正文 + 实时预览、可用变量芯片（点一下插到光标处）、未注册引用的警告，底部「保存修改」。**订阅条目的正文只读**，另有「fork 成本地条目」。
- **来源页 / 变量页 / 脚本编辑器 / 组合页**：分别见后面四节。

**生效时机是下一个模型步骤**：`systemPrompt.assemble()` 每个 agent step 调用一次，section 文本每次现算，所以开关、排序、正文都不需要重启。改插件代码另说，见文末「注意」。

**持久化**：由原生 `configForms` 的 `writable/mode` 决定是否可写；接受的修改进入当前 Profile patch。非本机浏览器默认可能使用只读内存表单，已安装且启用的 LAN 设置提供方可恢复经过宿主鉴权的写入。页面不会把拒绝或缺少接受回执当成保存成功。

**删除**一条 = 先删正文文件、再从索引移除（顺序有意：文件删不掉时索引不动，条目还在、还能重试）。

## 压缩指令

DSH 把上下文压成摘要时，会额外发一次模型调用：重放当前对话前缀，最后追加一条**指令消息**告诉摘要模型输出什么结构。这条指令原本写死在 `dsh-compaction-basic` 里，本插件让你把它换成自己写的一条 markdown —— 和普通条目一样有 id、有正文文件，但不属于组合，由每个会话手动指定。

- **建一条**：列表页底部「新增压缩指令」。分配一个 id 并直接打开编辑页，**正文是空的** —— 这条指令要替换的是 DSH 自带的那一份，从这里读不到它，所以不预填骨架（照抄一份既是替别人的措辞做猜测，也会随上游改动过时；顺带一提，那样抄来的文字里只要出现 `{{...}}` 形状的字面量，就会被下面的引用校验直接拒绝保存）。**这是一份草稿：不保存就什么都不写**，直接返回不会在列表里留下空条目（离开前会确认一次，问的是「放弃这条新压缩指令？」）。点「保存修改」时只写两样：正文文件、索引里那条记录。它不是 system prompt section：**不注册 section、不参与注入开关**，`order` 只影响列表排序；列表里那一行也不带开关（它的 `enabled` 不决定任何事），只标一句「每会话自选」。
- **改正文**：照常进编辑页写，正文里可以用 `{{变量}}`（插值规则与 section 相同，见「变量」一节；解析不了的引用按字面量写出去并记一条日志，绝不让那次压缩失败）。
- **哪个生效**：**每个会话自己在会话输入框那一行的「压缩」芯片里选**，选的结果记在那个会话自己的文件里（见「每会话选择」）。选「不用」= 用 DSH 自带的那条。没有选过的会话就用 DSH 自带的；新会话不继承任何别的会话的选择。选中的 id 指向不存在的条目、指向普通段落条目、或正文为空 → 回退到 DSH 自带指令并记一次日志。**永远不会有"空指令"发出去**。
- **页面上没有任何东西能把某条指令"设为当前"**：设置页是编目录的，不是替哪个会话做选择的。想让它生效，去那个会话的「压缩」芯片里选它 —— 保存或改正文之后页面上会直接这么说。删除一条也不会去动任何会话的文件：选过它的会话读到一个不存在的 id，就按上面那条回退，并在日志里被点名一次。
- **生效时机是下一次压缩**，不是下一个模型步骤 —— 压缩什么时候发生由 DSH 的阈值策略决定（默认上下文用到 80%）。想立刻验证：`/compact`，或把阈值调低。
- **组合包不再导出压缩提示词**，也不包含 `preset.compaction`。旧版组合包仍可导入：其中的压缩正文保留为**独立的压缩条目**，从组合成员里移除，并忽略旧绑定；需要使用时，在会话的「压缩」芯片里手动指定。导入不会替任何会话做选择，也不会改动已有选择。
- **看它有没有真的生效**：列表页状态行显示 `压缩指令：每个会话自己选 · 已替换 N 次 · 最近 <时间>`（N 来自 `/dsh-prompt-manager/status` 的 `compaction` 字段）。它报的是**全机**计数器，不报"哪个会话正在用哪条" —— 那是会话自己的事情，页面看不到；摘要看起来"格式不一样"的时候，第一个该看的就是这行。
- **改不了的部分**：摘要落进会话时外面那层 `<compacted-summary>` 标签和「自动生成的检查点」前导语（`This is an automatically generated checkpoint …`）是后端在摘要返回**之后**自己拼的，不在这次请求里，所以拦不到。要改它们只能自己写一个压缩后端（实现 `CompactionEngine`）。本插件只替换**发给模型的指令**。
- **关掉**：`compaction: false`，所有压缩调用恢复原样。

## 组合

一个**组合** = 从现有条目里挑一组，起个名字。两个入口：

- **会话输入框那一行的**工具行右侧（模型选择器左边）有「提示词 · …」芯片：点开是全部组合和「不用组合（按每条开关）」，选中即切换 —— **只切这个会话**。
- **设置 → 提示词 → 组合**：增删改，每个组合用勾选清单挑**普通提示词**（含关着的）—— 「把某条关掉的提示词临时打开」正是组合的用途。组合编辑器没有压缩指令选择器，组合卡片也不再展示压缩绑定；压缩指令只能在会话的「压缩」芯片中手动指定。

三点要紧的：

1. **一个会话选了组合，就是那个组合说了算**：每条自己的开关原样留着，但不参与判断；在那个会话里切回「不用组合」，就回到那些开关。设置页不标"哪些条目被注入了"，因为那是某个会话的事实，页面看不到。
2. **切换只影响做出这个选择的那一个会话**，在**下一个模型步骤**生效，不需要重启、也不需要重注册 section。代价是那个会话的 system prompt 变了，KV cache 前缀失效一次。别的会话一个字都不变。
3. **组合管选哪些，不管顺序**：顺序仍是每条自己的 `order`。

**组合和压缩选择完全独立**：选择、切换、取消组合都只改会话的 `preset`，保留其 `compaction`；手动切换压缩指令只改 `compaction`，保留 `preset`。没有“跟随组合”的模式，也不会把两份压缩提示词叠加使用。

`presets` 里可以写索引里还不存在的 id（订阅还没拉回来），组合页会标成「条目不存在」而不是替你删掉；某个会话正用着这个组合时，宿主也会在日志里点名一次。上限 20 个组合、每个 50 条成员。某个会话选中的组合不存在（比如你刚把它删了）时不会冻住提示词：回到单条开关并记一次警告，只影响那个会话。

### 组合包：把一个组合导出成文件

组合页每个组合的「⋯」菜单 + 页脚，导出得到 `prompt-manager-pack-<组合 id>.json`。包里装什么按"正文属于谁"分：

| 成员类型 | 包里放什么 | 为什么 |
|---|---|---|
| 本地 / 内置条目 | 正文**内联** | 除了这份文件没有别处能复现它 |
| 订阅条目 | 只记来源（`slug` + `repo` + `ref` + `file`） | 正文属于上游；导入方配上同一个仓库，正文自然就出来（同 repo ⇒ 同 slug ⇒ 同 id） |
| 指向已不存在条目的 id | 记进 `missing`，如实报告 | 这是在说"这个包不完整" |

导入时：**id 撞车就加后缀**（`env` → `env-2`，组合成员同步改写，所以同一个包导两次是两个集合）；**换了 id 的订阅条目放弃来源标记**（正文按 id 去上游找，id 变了就永远读不到，留着只读标记反而更糟）；**绝不导入脚本**（脚本是代码）；正文里有写法不合法的 `{{...}}` **整包拒绝**（那种正文一进索引每个步骤都会失败）；**先校验、再写正文、最后一次性写索引**，写正文中途失败会把已写的文件删掉。导入不会自动启用那个组合，也不会替你配来源。

## 每会话选择

"有哪些提示词、哪些组合、每条正文写什么"是**全机一份**的目录；"现在这个会话用哪套"不是。后者记在每个会话自己的文件里：

- **位置**：`<storeDir>/sessions/<会话 id>.json`（默认 `$DSH_HOME/prompt-manager/sessions/`）。一个会话一个文件，内容是 `{"preset": "<组合 id>", "compaction": "<压缩指令 id>"}`，两个字段都用 `""` 表示"没选"。
- **默认**：没有文件的会话 = 从没选过 = **不用组合**（每条自己的开关说了算）、**不用自定义压缩指令**（用 DSH 自带的）。新会话永远从这个状态开始，不继承任何别的会话。
- **怎么改**：会话输入框那一行的「提示词」和「压缩」两颗芯片。切一下就是这个会话的事，别的会话不受影响；下一步模型生效（压缩是下一次压缩生效）。也可以手改那个文件 —— 宿主每次组装都重新读，不需要重启。
- **落盘、重启后还在**。旧会话没有文件，就是"没选过"，所以升级不需要任何迁移动作。
- **有上限**：最多 200 个会话保留选择，超过就按文件修改时间从旧到新删。
- **读不出来也不报错**：文件损坏（JSON 解析不了）按"没选"处理，并在日志里说一次；指不到东西的 id 按上面「压缩指令」「组合」两节里的回退规则处理。
- **接口**：`GET /dsh-prompt-manager/session/<会话 id>` 读（返回 `{ session, preset, compaction, stored }`）、`POST` 同一个地址合并写（body `{preset?, compaction?}`）、`DELETE` 清掉。`/status` 的 `sessions` 字段报 `{ dir, count, writable }`，即文件放哪、几个会话有、现在能不能写。这些路由和 `/api` 用同一把尺子（本机对端，或部署信任的 Host + 浏览器会话；写操作再加 same-origin），所以从别的设备打开的界面里，只要那一页有会话，这几颗芯片就能用。
- **`settings.yaml` 里的 `activePreset` 和根 `compaction` 保留但不再决定任何事**，只是为了让旧文件还能通过 schema 校验。设置页也不会再去读它们。

## 订阅 GitHub 仓库

一个**来源** = 一个仓库 + 一个 ref。在**来源页**填 `owner/name`、ref（分支 / tag / commit）和可选镜像；它接上会检查一次，之后**只在你点「检查更新」时**才联网。

### 仓库要长什么样

根目录必须有一份 `prompt-manager.json`（[dsh-prompt-pack](https://github.com/lolkda/dsh-prompt-pack) 根目录那份就是示例）：

```json
{
  "prompts": [
    { "file": "contract.md", "title": "CTF 契约", "order": 10 },
    { "file": "fastctx.md", "title": "FastCtx 工具路由", "order": 20 }
  ]
}
```

`id` 缺省取文件名，`title` / `order` / `enabled` 可以不写。要这份清单是因为列举目录要么消耗 GitHub API 配额、要么解析整仓 tarball，而"作者多写一个文件"代价最低。清单是远端内容，所以每个字段都校验：非法路径、`..`、非 `.md`、重复文件、超过 50 条都拒绝。

### 上游改了文件名怎么办

条目的 id 是**身份**（组合记的是它，正文也按它去来源里找），所以改名不能让 id 跟着变。三层保护：

1. **清单里写 `id`（最可靠）**：`{"file": "ctf.md", "id": "contract"}` —— 之后文件怎么改名、正文怎么改，本地 id 都不动。它还是**修复手段**：组合里记着已不存在的 id 时，在上游清单里把它写回来，检查 → 应用，那条成员就重新生效（人工给的标题 / 顺序 / 开关一起回来）。
2. **正文没变的改名会自动认出来**：一次检查里恰好一个文件被删、一个文件新增且正文 sha1 相同，就判定改名，新路径沿用旧 id，列表里标「由 prompts/contract.md 改名」。
3. **认不出来时不猜**：改名同时改了正文、或两个新文件正文一样无法判断谁继承身份 —— 按"删一条 + 加一条"处理并说明原因（要固定身份就回到第 1 条）。

改名在计划里是**一对变更**：只勾一行，应用时两行一起落（只应用一半会让两条记账共用一个 id）。id 真的变了时，你给旧 id 设的标题 / 顺序 / 开关会跟着搬到新 id。

### 手动更新的四步

1. **检查更新**：分支先用 `github.com/<repo>/commits/<ref>.atom` 拿 head sha（**零 API 配额**），没变就说"已是最新"；变了才逐文件发 `If-None-Match` 条件请求，304 复用本地。本地正文被手工删过时退回无条件请求取回来。
2. **看变更**：每文件一行 `prompts/a.md  +14 / −3`，带勾选框（默认全选）。远端删掉的标「（删除）」，认出的改名标「由 … 改名」。
3. **应用**：旧正文进 `previous/`，暂存覆盖 `current/`，写回 `state.json`，补上新条目 —— **新条目默认关闭**。
4. **还原**：一次撤销上一次应用（被删的文件连标题 / 顺序 / 开关一起回来）。

订阅条目的正文只读（想改就 fork），标题 / 顺序 / 开关照旧可改；来源被删时它的条目一起移除。把来源的 `enabled` 设成 `false` 是"先停对上游的动作、别动在用的正文"：检查 / 应用 / 还原都返回 409，已应用的条目照常注入。

### 通道与文件布局

| 环节 | 走法 |
|---|---|
| 变化探测 | `https://github.com/<repo>/commits/<ref>.atom`（直连，不消耗配额） |
| 取正文 | `<镜像>/https://raw.githubusercontent.com/...` 或 `{url}` 模板，带 `If-None-Match` |
| 代理 | `none` = 默认 fetch（已继承 DSH 启动器从环境变量装的全局代理）；`http` = undici `ProxyAgent`；`socks5` = undici 的 `Socks5ProxyAgent` |

镜像**只作用于 `raw.githubusercontent.com`**，`api.github.com` / `codeload.github.com` 一律直连。镜像返回 HTML 页面时会被识别并报错，绝不会把错误页当提示词暂存。代理与镜像全局一份，写在 `settings.yaml` 的 `prompt-manager` 段：

```yaml
prompt-manager:
  mirror: 'https://gh-proxy.example'      # 空 = 不过镜像
  proxy: { kind: socks5, url: 'socks5://127.0.0.1:1080' }
  sources:
    - id: owner-repo                       # 从 owner/repo 派生，可手改
      repo: owner/repo
      ref: main
      mirror: ''                           # 空 = 沿用全局
      enabled: true
```

```
$DSH_HOME/prompt-manager/
  sections/<id>.md                        本地条目正文
  scripts/<name>.js                       变量脚本（一条一个文件，输出一个 JSON 对象）
  scripts/.state.json                     每条脚本上次成功运行的 sha1 / 时间 / 变量值 / 退出码
  sources/<slug>/current/<file>.md        订阅正文快照
  sources/<slug>/previous/<file>.md       上一次应用替换掉的版本
  sources/<slug>/staging/<file>.md        检查下载完、还没应用的正文
  sources/<slug>/state.json               应用时间、head sha、逐文件 sha1/etag、undo 账本
```

## 配置

插件不带提示词，所以配置里只剩它注册的变量和正文目录；排序、section 名、正文本身都是每条自己的事（section 名固定为 `user:prompt-manager:<id>`）。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `environment` | `true` | 注册下面那组环境变量 |
| `variables` | 空 | 额外的固定值变量 `{{名字}}`。名字要满足 `[a-z][a-z0-9_]*`，不能和已注册的重名 |
| `probes` | 空 | 挂载时跑一次的命令，每个注册一个变量（见下节）。最多 64 项 |
| `probeDefaults` | `true` | 同时运行包内自带的探测默认值（`pwsh` / `bash` / `git` / `node` / `python`），内置条目靠它们解析变量 |
| `scripts` | 空 | 变量脚本的执行覆盖：`{ <脚本名>: { command, args, timeoutMs } }`，默认 `node <脚本>`、3 秒超时；`args` 里的 `{script}` 换成脚本绝对路径 |
| `probeTexts` | 英文占位符 | 探测没拿到版本时的文案，可覆盖 `missing` / `empty` / `timeout` / `skipped` |
| `probeBudgetMs` | `8000` | 整轮探测的时间上限，超出的记 `skipped` |
| `storeDir` | `$DSH_HOME/prompt-manager` | 存储根目录：正文在其中的 `sections/`，每会话选择在其中的 `sessions/`。`$DSH_HOME` 取值：显式 `storeDir` > 非空 `$DSH_HOME` > `~/.dsh` |
| `compaction` | `true` | volatile 开关：`false` 禁用替换，`true`/缺省启用；字符串仅保留旧索引指针的兼容读取，不替任何会话做选择。每次解析均读取当前值，关闭后再开启不需要重挂。没有会话选择时压缩调用仍原样发出 |

## 内置条目

包里只有一条：`environment.md`（id `env`，标题「机器环境」，order 5），索引放在 settings 的 **base 层**，所以新装起来打开设置页就能看到、能拨开关、也能编辑。同一个 id 的取值优先级：订阅快照 > 本机正文文件 `sections/env.md` > 包内正文。

- **关掉**：设置页拨开关。**删掉**：会往 user 层写一份不含该 id 的 `entries`（base 层被整体遮蔽）；想恢复就删掉 `settings.yaml` 里 `prompt-manager.entries` 这一项。
- 部署**没有 settings 服务**时也照样注入（此时索引就是内置条目本身）。
- 内置正文的系统信息由本插件注册的环境变量提供，工具版本由包内探测默认值提供；**工作目录使用 DSH 自带的 `{{cwd}}`**，每次组装读取当前会话的目录，不取宿主进程的 `process.cwd()`；**当前模型和提供方使用 `{{model}}` / `{{provider}}`**，跟随当前 agent 的选择，切换模型后下一个模型步骤更新。关闭 `environment` / `probeDefaults`，或在没有 DSH 会话变量提供者的独立注册表里组装时，相应的缺失引用会按字面量渲染并记一条警告，不会让组装失败。
- **已经编辑过「机器环境」的正文不会被升级覆盖**：本机正文仍优先于包内模板。想让已有自定义正文也提示工作目录和模型，在编辑器中加上 `This session's working directory is {{cwd}}.` 以及 `This agent's current model is {{model}} (provider: {{provider}}).` 即可；保存后下一个模型步骤生效。
- **更新后看起来还是旧正文时，先核对来源**：`GET /dsh-prompt-manager/body/env` 的 `source: "user"` 表示当前使用本地覆盖，而非包内模板。重启不会取消这个覆盖。推荐先备份，再只补入上述会话信息，保留已有定制；不要把「删除条目」当作恢复包内正文。

## 探测：把工具版本变成变量

`probes` 让插件在**挂载时**跑一遍命令，把结果注册成变量。包内已带一组默认探测（`pwsh` / `bash` / `git` / `node` / `python`），下面是覆盖或补充：

```yaml
config:
  probes:
    pwsh:   { command: pwsh,   args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'] }
    git:    { command: git,    args: ['--version'], pattern: '([0-9]+\.[0-9]+\.[0-9]+)' }
    node:   { command: node,   args: ['--version'], pattern: 'v?([0-9.]+)' }
    python: { command: python, args: ['--version'], pattern: '([0-9.]+)' }
    rust:   { command: rustc,  args: ['--version'] }
  probeTexts: { missing: '无' }
```

```markdown
- Git {{git}}，Node {{node}}，Python {{python}}，Rust {{rust}}
```

| 字段 | 说明 |
|---|---|
| `command` | 可执行名（走 `PATH`）或绝对路径 |
| `args` | 固定参数数组，默认不经 shell |
| `shell` | 经平台 shell 执行。Windows 上 `npm` / `pnpm` 这类 `.cmd` 垫片必须设 `true`，否则 `EINVAL` |
| `pattern` | 可选正则，取第一个捕获组；匹配不上就退回整行 |
| `timeoutMs` | 这一项的超时，默认 1500 |

四种结果都是**有值的字符串**，所以引用永远不会渲染成空：有输出 → 第一条非空行（`stdout` 或 `stderr`，套 `pattern`、截断到 120 字符）；起不来 → `missing` 文案（默认 `(not installed)`）；起来了没印东西 → `empty`（默认 `(no output)`）；超时 / 预算用尽 → `timeout` / `skipped`。

四条要紧的话：**只在挂载时跑一次**（DSH 的变量 provider 每次组装同步求值，把命令放进去等于每个步骤起一批子进程；装了新工具就改一下 config 或重启）；**同名项是整体替换**（`git: { command: git }` 会连 `args` 和 `pattern` 一起丢掉）；**名字被占了只警告不炸**（跳过这一项，其余照常）；**写错的配置直接拒绝挂载**（变量名不合法、缺 `command`、`pattern` 不是合法正则、超过 64 项）。命令在宿主进程里执行、不经工具沙箱，但只来自组合配置这个部署自己的文件，永不接受模型或页面的输入。

## 变量脚本：让提示词用你自己写的 JS

一条脚本 = 一个文件 `scripts/<name>.js`，跑起来是**独立子进程**，**打印一个 JSON 对象**，键就是变量名 —— 所以一条脚本能给多个变量：

```js
console.log(JSON.stringify({ rust: '1.80.0', go: 'go1.22' }))
```

值只在**挂载时**或你点「运行一次 / 重新测量」时测一次，之后每次组装读内存里的值。

四步：**新建脚本**（给个名字，页面给一份能直接跑的模板）→ **改**（往 JSON 里加键）→ **运行一次（测试）**（跑的是保存时会跑的同一件事：同一条命令、同一个工作目录；页面列出这次会提供哪些变量、退出码、耗时、stderr。**测试不写文件、不注册变量**）→ **保存并启用**（保存会先跑一遍，输出不是合法 JSON、变量名不合法、名字和别人撞车都拒绝，磁盘上不会留下坏脚本；通过后落盘并注册，下一个模型步骤生效）。回到正文编辑器，输入框上方列出当前可用变量，点一下插到光标处；目录外的引用会显示核对提示，实际能否解析以会话组装为准。

| 事情 | 行为 |
|---|---|
| 输出 | 平铺 JSON 对象，值是字符串或数字；数组、嵌套对象、null、空对象都拒 |
| 变量名 | `^[a-z][a-z0-9_]*$`，最长 64 |
| 长度 / 数量 | 值超 120 字符截断；单脚本最多 64 个变量，脚本最多 20 条 |
| 非 0 退出码 | 输出还能解析就照用，退出码显示在页面上 |
| 超时 / 起不来 | 默认 3 秒后杀掉（只杀解释器本身）；`node` 不在 `PATH` 上报「无法启动」 |
| 失败时 | **保留上一次成功测到的值**，错误显示在变量页，提示词不受影响 |
| 删除脚本 | 文件与缓存一起删。仍被引用的变量冻结在最后一次的值上，没被引用的连变量一起删；删除前页面列出哪些提示词还在引用它 |
| 改名 | 先删旧的、再存新的（旧名字的变量会被新脚本接管）。两条脚本抢同一个名字会被拒（409） |
| 手工放文件 | 直接把 `.js` 丢进 `scripts/` 一样生效，下次打开页面就能看到；没有缓存的会在挂载后台跑一次补上 |

默认 `node <脚本绝对路径>`，工作目录是 `scripts/`，继承宿主环境变量，另加 `DSH_PROMPT_MANAGER=1` 和 `DSH_PROMPT_MANAGER_SCRIPT=<名字>`。换解释器或加参数写 `config.scripts`：`inventory: { command: 'python', args: ['{script}'] }`。

**脚本以宿主进程的身份运行，没有沙箱** —— 能读能写能上网。写入和正文同一把尺子（本机对端，或部署信任的浏览器会话；再加 same-origin），但"设置页能写的东西现在包括会被执行的代码"这件事要心里有数：别放不信任的脚本，也别把面板开到你不信任的网络里。

## 变量

section 文本每次组装做 `{{变量}}` 插值。**实际值由运行时提供者解析**：本插件注册下面这 8 个，加上 `variables`、`probes`、脚本补进来的那些。DSH 自己提供 `{{cwd}}` / `{{provider}}` / `{{model}}`，按当前 agent / 会话解析；它们也列在可用变量目录中，但只有名称和说明，不携带全局固定值。下表列的是本插件的进程级环境事实：

| 变量 | 本机实测值 | 来源 |
|---|---|---|
| `{{os}}` | `Windows` | 友好平台名（`win32` → Windows，`darwin` → macOS，`linux` → Linux） |
| `{{os_release}}` | `10.0.19045` | `os.release()`：Windows 构建号 / Linux 内核版本 / macOS Darwin 版本 |
| `{{platform}}` | `win32` | `process.platform` |
| `{{arch}}` | `x64` | `process.arch` |
| `{{home}}` | `C:\Users\Administrator` | `os.homedir()` |
| `{{dsh_home}}` | `C:\Users\Administrator\.dsh` | 解析后的 harness home（`$DSH_HOME`，没设就是 `~/.dsh`），和正文目录用同一个解析函数 |
| `{{user}}` | `Administrator` | `os.userInfo().username` |
| `{{host}}` | `ADMIN-5MK6PJTEU` | `os.hostname()` |

都是**进程级事实**，挂载时算一次，运行期间不变（也不会白白让 KV 前缀失效）。正文里用 `{{dsh_home}}/profiles/web/vendor/...` 这种路径比硬编码 `C:\Users\...` 更经得起换机器。

**会话目录用 DSH 自带的 `{{cwd}}`，本插件不注册它**：`@deepseek-ai/dsh-agent-loop` 注册了 `{{cwd}}`（取值 `context.agent.session.header.cwd`，逐会话解析，是这个会话创建时的绝对目录）。本插件不能注册同名变量 —— 注册表同层重名会抛错，跨层则会被作用域层遮蔽 —— 但它完全可以被你的正文引用：写 `{{cwd}}` 就渲染成当前会话的目录。

**模型名称用 DSH 自带的 `{{model}}`，提供方用 `{{provider}}`**：初始值来自当前 agent 的 `options.model` / `options.provider`；模型选择模块会在每次组装时用当前选择覆盖这两个变量，并让同一步的请求使用同一份选择。因此不同会话互不串用，切换模型在下一模型步骤生效，不需要重启插件，也不会一直显示创建会话时的旧模型。这里显示的是 DSH 选择的**模型 ID 和 provider 路由 ID**，不是界面里的自定义展示名，也不推测网关背后是否另做了模型映射。不要在 `config.variables` 或变量脚本里把这两个名字写成全局固定值。

编辑器「可用变量」和变量页会同时列出 `{{cwd}}` / `{{model}}` / `{{provider}}`，标记为 **DSH 原生**，可以点击插入。设置页没有当前 agent 上下文，因此只显示“按当前 agent / 会话动态解析”，不显示某个会话的真实值；`/variables` 中这些条目没有 `value` 或 `updatedAt`，`/status.variables` 也不会伪造它们的全局值。页面预览只渲染 Markdown，真正插值发生在会话组装时。

**变量目录不是整个运行时注册表**：其他插件可能提供额外名字，目录外的引用只提示“未列入当前变量目录”，不能据此断言组装一定失败。原生引用也不会在组合包导入时被误报为未注册。

**没注册的引用不会炸掉组装**：插件把它转义成字面量并记一条警告（`test/guard.mjs` 与真实 `renderPrompt` 交叉验证）。但那一段注入的就真是 `{{名字}}` 原文 —— 别把它当兜底。

## 升级

### 从 3.3.2（3.3.3）

- **修 3.3.2 里"信任权威读不到"的问题**：`connection` 是**兄弟行**（`connection` 行）提供的服务，cordis 里兄弟行的服务**只有声明了依赖才看得见**。3.3.2 想从 `webServer` 的作用域里 `Reflect.get` 摸它，真实组合下必然抛 `cannot get property "connection" without inject`，被吞成"没挂 Connection"，于是局域网页面照旧全灭（只是报错换成了中文的 `no-trust-authority`）。现在改成**声明式注入**（`ctx.inject(['connection'], …)`，和 `@lolkda/dsh-web-lan` 同一个做法）：没挂 Connection 的组合照旧只服务本机，挂了的就按它的判定走，后挂载也能在下一次请求生效。
- 测试里那个假 ctx 之前**太宽松**（它让插件看见了没声明的服务），所以 3.3.2 的测试是绿的、真机是坏的。现在假 ctx 忠实模拟 cordis：兄弟行提供服务、只有声明过的才看得见、没声明的读会抛 —— 这条 bug 现在有测试守着。

### 从 3.3.1（3.3.2）

- **路由不再自己判信任**：原先这条路由要求"对端必须是 loopback"，比宿主还严。装了 `@lolkda/dsh-web-lan` 之类的部署之后，`/api` 通、这条路由不通，于是从别的设备打开的设置页**不是只读，而是整个存储不可达** —— 正文目录空白、订阅/变量/组合计数全 0，还把服务端那句英文原文糊在页面上。
- 现在本机对端照旧（免会话，`Host` 仍必须是本机名），**其它对端交给宿主自己的浏览器信任**（和 `/api` 同一把尺子：部署信任的 Host + 浏览器会话），写操作仍要 same-origin。**部署怎么放宽，插件跟着放宽**，插件不额外加宽也不额外收窄。
- 拒绝都带 `code`（`host-not-loopback` / `no-trust-authority` / `no-session` / `host-not-trusted`），页面按 code 说中文，不再引用宿主原文。
- 客户端**不再捏造事实**：读不到就说"读不到"（原来会捏一个 `writable: false` 的假 store，把编辑器点亮、让保存必失败），压缩指令读不到时也不再断言"已关闭"。
- **没有配置或数据迁移**：路由路径、返回结构、设置字段都没变。

### 从 3.3.0（3.3.1）

- 修复 `cwd` / `model` / `provider` 不显示在可用变量按钮中、被编辑器和组合包导入误报为未注册的问题。
- 原生变量标记为「DSH 原生」，目录仅提供名称、作用和引用关系；实际值仍由 DSH 按当前 agent / 会话解析，不重复注册，不缓存成全局值。
- 变量目录外的引用改为核对提示；真正的解析校验仍以每次会话组装为准。Markdown 预览不会代入某个会话的实际值。
- 本地自定义正文的优先级不变，不会为了显示新变量而覆盖已有内容。

### 从 3.2.3（3.3.0）

- 组合只包含普通提示词，不再提供压缩选择器、绑定字段或压缩正文导出。选择、切换或取消组合不会改动会话的压缩指令。
- 压缩提示词只通过会话的「压缩」芯片手动指定；没有选择的新会话使用 DSH 默认指令。
- **已保存的会话选择保持不变**。旧数据没有记录压缩选择来自手选还是组合带入，无法可靠区分，所以不会自动清空；不再需要的选择可手动改为「DSH 自带」。
- 旧组合的 `compaction` 字段被忽略，组合写回时不再携带它。旧版组合包仍可读取，其中压缩正文保留为独立条目，不属于导入的组合，也不会自动选中。组合包格式版本仍为 1。

### 从 3.2.2（3.2.3）

- 内置「机器环境」增加**当前会话的工作目录** `{{cwd}}`，以及**当前 agent 的模型和提供方** `{{model}}` / `{{provider}}`。
- 复用 DSH 原生变量，每次组装按当前 agent / 会话解析；不同对话互不串用，切换模型后下一模型步骤更新。没有新增全局固定变量或运行依赖。
- **无需迁移配置或会话数据**。包内模板更新不会覆盖你已经编辑的「机器环境」正文；已有自定义正文要使用这些信息，手动加入相应变量即可。

### 从 3.2.1（3.2.2）

修一个只跟 **DSH 版本**有关的问题：在 **0.1.6-alpha.2** 上，会话输入框那行的「提示词」「压缩」两颗芯片**点不动** —— 菜单照开、组合照列，但每一项都是灰的，点一下什么都不发生。数据面一个字没改。

- **原因**：3.2.1 靠读 `ctx.sessions.list` 快照里的 `current` 字段知道"现在是哪个会话"。`0.1.6-alpha.2` 把这个字段删了（`0.1.6-alpha.1` 还在，`0.1.5` 也在），于是两颗芯片拿到的一直是 `undefined`；而它们在 `undefined` 时把菜单项全标成 `disabled` —— 表现就是"菜单能开、点不动"。
- **现在改成**用**槽自己交出来的那个 id**：`conversation.input.right` 声明的就是 `scope: 'session'`，DSH 渲染时会把"这个输入框属于哪个会话"作为 `sessionId` 属性交给注册方（`ui-session` 的标准属性，`0.1.5` 起就有，跨版本稳）。不再依赖任何会变的快照字段。
- 顺带两处小改：插件不再注入 `sessions` 服务（`inject` 只剩 `['slots', 'settingsScope']`，`dsh.client.inject` 里的 `@deepseek-ai/dsh-api-session-controller` 也一起去掉 —— **这一项是启动时快照，改它要重启 profile**，只改 `client/client.js` 的内容则靠 HMR）；只读页面（局域网地址打开、设置通道退化为内存模式）下「不用组合（按每条开关）」「不用：DSH 自带的压缩指令」这两项也一起禁用 —— 它们同样是写操作，以前放行只会把一次点击变成一条"切换失败"。
- **升级动作：没有。** 会话文件格式、路由、行为、已选的组合全不变。

### 从 3.2.0（3.2.1）

只少了一颗按钮，不动数据面：

- 编辑页去掉了「转为压缩指令 / 转为普通段落」：一条条目是段落还是压缩指令，在「新增提示词 / 新增压缩指令」建它的时候就定下了，之后不再互相转换。索引里的 `kind` 仍然是"它是什么"的唯一依据（宿主照旧只读它，从来没写过），所以**已在用的条目、每个会话的选择、组合包格式都不受影响**。

### 从 3.1.x（3.2.0）

**"哪个组合 / 哪条压缩指令生效"从全机一份改成每个会话各记各的**，落盘在 `<storeDir>/sessions/<会话 id>.json`。不需要迁移动作：

- 升级前是"全局生效"的（`activePreset` / 根 `compaction`），升级后这两个字段**不再决定任何事**，只是留着让旧文件还能过校验。所以升级后**所有会话都回到"没选过"**：不用组合（每条自己的开关说了算）、用 DSH 自带的压缩指令。想给某个会话恢复某套组合，在那个会话的「提示词」芯片里选一次就行，一次点击，只影响它。
- 新装了本插件但还没打开过任何会话前，行为和以前一样：没选组合时每条自己的开关决定注入，没选压缩指令时压缩调用逐字节不变。
- 想在升级前先看看有没有人在用：`settings.yaml` 里的 `activePreset` 和根 `compaction` 就是旧的全局值，照它挨个会话选一次即可。
- 组合自身的 `compaction` 字段（以及包里的 `preset.compaction`）语义收窄为"**从这个会话的芯片里选这个组合时，顺手带上这条压缩指令**"，不再是"组合生效时它决定用哪条"。
- 设置页少了几处入口：组合的「设为当前 / 取消当前」、压缩指令行的「设为当前 / 取消当前」和那颗开关、压缩编辑器里的「设为当前」。理由同上 —— 那些入口只能"替所有会话一起决定"。压缩指令行改成标一句「每会话自选」。

### 从 3.0.x（3.1.0）

只加东西，不需要迁移：

- 索引多了可选字段 `compaction`（根字段）和组合上的 `compaction`、条目上的 `kind: 'compaction'`。老文档原样生效：没有 `compaction` 就继续用 DSH 自带的压缩指令，升级前后**压缩调用逐字节相同**。
- 组合包格式 `dsh-prompt-manager-pack` 版本仍是 1：包里多出可选的 `preset.compaction` 与 `entries[].kind`，3.0 写的包照样能导入（导入后组合不带压缩指令）。
- 宿主多了一个可选依赖 `@deepseek-ai/dsh-llm`（只用到它的类型；运行时经 `ctx.inject(['llm'], …)` 取服务，没有它插件照常挂载，只是没有压缩接缝）。

### 从 2.x（3.0.0）

只换**对外身份**，不动数据面：

| 变了 | 2.x | 3.0.0 |
|---|---|---|
| npm 包名 | `dsh-prompt-manager` —— 该名字在 npm 与 DSH 商城上已被另一个插件占用 | `@lolkda/dsh-prompt-manager` |
| 客户端插件 id | `dsh-prompt-manager` | `@lolkda/dsh-prompt-manager`（必须等于包名） |
| cordis 插件名 / 挂载行 id | `prompt-manager` | `dsh-prompt-manager` |
| HTTP 路由前缀 | `/prompt-manager` | `/dsh-prompt-manager` |
| 安装方式 | 手改 profile 的 patch | `dsh plugin … add` 一条命令 |

**没变的（所以不用迁移）**：settings 命名空间 `prompt-manager:`、正文目录 `$DSH_HOME/prompt-manager/`、section 名 `user:prompt-manager:*`、组合包格式 `dsh-prompt-manager-pack`。手写挂载的把 patch 行的 `id` 改成 `dsh-prompt-manager`（`name` 不用动），装包的用新包名重装一次，然后重启 profile、刷新页面。

### 从 1.x（2.0.0）

2.0.0 把插件从「CTF 契约注入器」改名成通用的提示词管理器（插件名与仓库名从 `dsh-ctf-prompt` 换成 `dsh-prompt-manager`，旧 GitHub 地址 301）。要改三处：挂载行用新的 vendor 路径或包名；`settings.yaml` 的 `ctf-prompt:` 段改名成 `prompt-manager:`（`entries` 不用动）；`$DSH_HOME/ctf-prompt/sections/*.md` 挪到 `$DSH_HOME/prompt-manager/sections/`。同一次改名里 `contract` / `fastctx` 两条种子条目移出仓库，变成 [dsh-prompt-pack](https://github.com/lolkda/dsh-prompt-pack) 这份可订阅的包。

## 为什么用插件而不是 AGENTS.md

DSH 里两种注入方式落在不同通道：

| 方式 | 落点 | 声明优先级 |
|---|---|---|
| `ctx.systemPrompt.section()`（本插件） | system prompt 正文 | 高 |
| `AGENTS.md` / `CLAUDE.md` | 对话里的 user 角色 `<system-reminder>` | DSH 明确声明「不覆盖 system 指令」 |

插件注册的 section 会和 harness identity、persona、工具指引拼成同一段 system prompt，因此权威性和它们完全等同。需要「必须遵守」的契约时用这个；描述性的项目知识仍然放 `AGENTS.md` 更合适。

## 注意

- **改插件代码要重启，改浏览器半边不用**：DSH 不监听插件模块文件，loader 按 URL 缓存 ESM 模块，所以改完 `lib/` 必须重启 profile。浏览器半边另有一条 HMR 链路（`dsh-client-hmr` 轮询已注册 bundle，字节一变就通知页面原地重载）；部署没挂 `dsh-client-hmr` 时没有这条链路，刷新页面也可能吃到旧副本，只能重启。
- **`dsh.client` 那类元数据是启动时快照**：改动 `inject` 列表或包名要重启 profile；只改 `client/client.js` 的内容靠 HMR。
- **改正文不用重启**：`sections/*.md` 每次组装现读；订阅正文点过「应用」后也是下一次组装生效。**加变量脚本不用重启**：脚本是数据文件，保存时插件自己注册新变量。
- **脚本值不随会话变**：值在挂载或你点「重新测量」时测一次就固定。这既是性能考虑，也是 KV cache 考虑 —— 随每次组装变化的变量会让缓存前缀每步失效。会话相关的事实（模型、cwd 之类）归注册它们的插件所有，不在这个插件里造。
- **section 名是派生的**：每条固定 `user:prompt-manager:<id>`，所以只要 id 不重复就不会和 `deployment:persona`、`harness:identity` 这类已注册 section 撞名。
- **package.json 的三样必须同时在位**：`dsh.client`、`exports["./client"]`、`client/client.js` —— 只声明浏览器半边而没有 bundle，浏览器插件表挂载时会直接报错。bundle 工厂的 `id` 必须等于包名。
- **KV cache**：section 文本或顺序一变，缓存前缀从该点失效；文本稳定时开销只有一次。某个会话切换组合就是给它换一组 section，所以那个会话每切一次失效一次，别的会话的前缀不受影响 —— 换来的是不用重启、不用重开会话。

## 开发

```bash
npm install          # 只装开发依赖：typescript 与 DSH 类型包
npm run build        # src/*.ts -> lib/*.js + lib/types/*.d.ts，并检查 client/client.js
npm run typecheck    # tsc --noEmit
npm test             # 先构建，再跑十四个测试（test/*.mjs，各自文件头有说明）
npm run check:build  # 核对 lib/ 没有未提交的改动（提交前跑）
npm run check:pack   # 核对 npm 会打包的内容里有 bundle patch、浏览器半边、构建产物
```

**发布由 tag 触发**。`.github/workflows/ci.yml` 在每次 push / PR 上跑构建、测试、`check:build`、`check:pack`（ubuntu + windows 两个平台）；`.github/workflows/release.yml` 只在 `v*` tag 上发布 —— 先校验 tag 与 `package.json` 版本一致，再跑同一套门禁，然后 `npm publish --provenance --access public` 并开一个 GitHub Release。发一版就三行：

```bash
npm version patch --no-git-tag-version   # 或手改 package.json
git add -A && git commit -m "chore: 3.1.0"
git tag v3.1.0 && git push origin main --follow-tags
```

认证走 npm 的 **Trusted Publisher（OIDC）**，仓库里不放任何 npm token —— npm 正在淘汰"绕过 2FA、长期有效"的发布 token，而 OIDC 换来的凭证只活这一次运行，并顺带生成 provenance（包页面上会标出它是从哪个 commit 的哪次运行构建的）。首次要在 npm 包页 Settings → Trusted Publisher 里填 `lolkda` / `dsh-prompt-manager` / `release.yml`。

`lib/` 与 `client/` 都提交进仓库，所以克隆下来就能按相对路径挂载，不需要工具链 —— 这正是 `check:build` 存在的原因：**`lib/` 与 `src/` 必须同一个提交**，否则挂载的是一份和源码对不上的代码（多出一个 `lib/foo.js` 而没 `git add` 时尤其隐蔽，挂载会直接 `ERR_MODULE_NOT_FOUND`）。改完源码：`npm run build && npm test && npm run check:build && git add -A && git commit`。

清单里**没有生命周期脚本**（`prepare` 换成了 `prepublishOnly`）：`npm install` 不构建、git 安装也不构建，因为 `lib/`/`client/` 就是构建产物；`prepublishOnly` 只在 `npm publish` 时构建一次。这不是洁癖 —— pnpm 12 会拒绝执行 git 依赖的构建脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），留着 `prepare` 等于让每个用 `dsh plugin add github:…` 装的人都撞一次墙。

### 包清单契约（照着做就能被 `dsh plugin` 装、被商城收录）

| 字段 | 本仓库的值 | 为什么 |
|---|---|---|
| `dsh.bundle.patch` | `./cordis.patch.yml` | DSH 靠它认「这是个 profile bundle」：装成依赖后**自动**进 `dsh.profile.bundles` 并应用这一层；商城没有它直接判 `SUBMISSION_BUNDLE_MISSING` |
| `dsh.client` | `{platform: 'web', inject: [...]}` + `exports["./client"]` | 浏览器半边；工厂 `id` 必须等于包名 |
| `dsh.compatibility.dsh` | `>=0.1.5-rc.1 <0.2.0` | 瞄准的 DSH 线。**不写不是"留空"而是被推断**：校验脚本会拿唯一的 `@deepseek-ai/dsh-*` peer 范围顶上，那是个依赖服务的范围，读起来像"任何 DSH 都行" |
| `dsh.compatibility.dshReleases` | 官方最新三个版本逐版本声明 | 商城上下架依据：至少要有一个精确的 `compatible`，全 `unknown` 会被转 `unlisted` |
| `dsh.compatibility.dshOperations` | 逐版本记 `install`/`start`/`uninstall`/`rollback` 四项 | 商城要的是**真跑过**的操作证据，范围声明不能顶替；只有实测过的版本写 `passed`，没测的照实写 `unknown`（实测过程见 `docs/marketplace-evidence.md`） |
| `engines.node` | `>=22` | 商城记录成兼容范围 |
| `publishConfig.access` | `public` | scoped 包默认私有 |
| `files` | 含 `lib`、`client`、`cordis.patch.yml`、`environment.md` | 装出来的包要自洽 |
| 生命周期脚本 | 无 | 见上 |

包内 `cordis.patch.yml` 只 `insert` 自己这一行，`id` 用插件自有、不与别家条目撞的 id（商城会拿它和所有既有条目的 `entryIds` 比对），并且**不允许**出现 `name: '@deepseek-ai/…'` 这种冒充官方组件的行。

装成包来验证（不碰你自己的 profile）：`dsh plugin --profile pmcheck add git+file:///D:/path/to/checkout`，然后 `dsh --profile pmcheck --dump-config` 应该能看到 `id: prompt-manager` 那一行 —— 它是包内 `cordis.patch.yml` 自己插进去的，`pmcheck` 的 patch 文件从头到尾没动过。看完 `remove` 掉、删掉 `$DSH_HOME/profiles/pmcheck` 即可。

## License

MIT
