# 交接：把「哪套提示词生效」做成按会话隔离（dsh-prompt-manager）

> 历史记录：本文中“切组合时一起写压缩指令”的设计已被后续改动取消。当前组合只包含普通提示词，切换/取消组合只写 `preset`；压缩提示词在会话中手动指定。旧组合的压缩字段被忽略，已保存的会话选择不清空。当前行为以 [README](../README.md#组合) 为准。

> 给下一个 Agent 读。仓库：`F:\环境\dsh-ctf-prompt`（`@lolkda/dsh-prompt-manager`，当前 package.json 版本 **3.1.9**，未提交的工作区里有本次改动）。
> 本文位置：`docs/handoff-per-session-choice.md`（仓库内）。它是本次改动的**工作交接**，不属于包内容 —— `package.json` 的 `files` 不含 `docs/`，所以不会被 npm 发布，但会随提交进 git。收尾时删掉即可。

---

## 0. 3.2.2 修正：芯片的会话 id 从哪来（先读这段）

本文 §4.5 与 §7 里"芯片去读 `sessions.list` 快照的 `current`"这件事**是错的**，3.2.1 照它实现，然后在 DSH 升到 **0.1.6-alpha.2** 之后两颗芯片全部点不动（菜单能开、组合项全灰）。原因：**`0.1.6-alpha.2` 把 `SessionListState.current` 删了**（`0.1.6-alpha.1` 与 `0.1.5-rc.1` 都还有这个字段），读不到就是 `undefined`，而芯片在 `undefined` 时把菜单项标 `disabled`。

正确的做法（3.2.2 已改）：**槽会自己把会话 id 交出来**。`conversation.input.right` 声明是 `{ kind: 'list', scope: 'session' }`，渲染时 `ui-session` 的标准来源会给每个条目注入 `sessionId` 属性（`props: ["sessionId"]`，0.1.5 起就有），`renderSlot(name, {})` 传的 owner props 里没有它**不等于**注册方拿不到它 —— 那是两套 share（owner props 与 framework standard kit），当时把后者漏了。所以芯片现在直接 `props.sessionId`，插件也不再注入 `sessions` 服务。

---

## 1. 目标（用户要的最终效果）

现在"用哪套组合、用哪条压缩指令"是**全机一份**：在 A 会话切一下，B 会话也跟着变。目标改成：

- **目录类东西仍然全局一份**：有哪些提示词、正文、订阅来源、组合的定义（成员清单）、镜像/代理。
- **只有"哪个组合生效 / 哪条压缩指令生效"变成每个会话各记各的**，落盘、重启后还在。
- 会话里切一下，只影响这个会话；下一步模型生效（压缩是下一次压缩生效）。

## 2. 已拍板的决策（别再改，除非用户改口）

| # | 决策 | 用户的选择 |
|---|---|---|
| D1 | 范围 | 只做"组合 + 压缩指令"两个指针；逐条开关/顺序仍全局 |
| D2 | 持久化 | **落盘**：`<storeDir>/sessions/<sessionId>.json`，一个会话一个文件 |
| D3 | 新会话初始值 | **不用组合**（各条自己的开关说了算）、**不用自定义压缩指令**（用 DSH 自带的）。全局 settings 里的 `activePreset` / 根 `compaction` 从此**不决定任何东西** |
| D4 | 旧会话怎么办 | **B：一律清空** —— 旧会话没有文件 = 从没选过 = 用默认。**不需要迁移动作**（这一点已经天然成立） |
| D5 | 验收 | 开两个会话：A 里切，B 不变；重启 DSH，A 的选择还在 |
| D6 | 测试 | 用户说"测试不用做了" —— 但**发布链会跑 `npm test`，红着就发不出去**，所以现有断言必须改绿（不新增测试） |
| D7 | 收尾 | 改完 **推送到远程**，触发打包 + npm 发布 |

## 3. 现在的状态

- 宿主侧（`src/`）：**实现完成，`npm run typecheck` 0 错误**。
- 客户端（`client/client.js`）：两颗芯片已改成按会话读写，`node --check` 通过；设置页里几处"全局设为当前"的入口已撤。
- **`npm test` 还没全绿**：`test/smoke.mjs` 目前停在最后一处断言（见 §5），客户端测试 `test/client.mjs` 还没跑（预期会红，见 §6）。
- 因此**现在还不能推**：`release.yml` 先跑 build/test/check:build/check:pack 才 publish。
- 运行中的 DSH **不受影响**：profile 用的是 npm 上的 `@lolkda/dsh-prompt-manager@^3.1.9`（`~/.dsh/profiles/web/node_modules/`），不是这个仓库。

## 4. 已完成的部分（逐项）

### 4.1 新模块 `src/sessions.ts`（约 420 行，全新）

`SessionChoices` 类：每会话选择的落盘存储。

- 路径：`<root>/sessions/<sessionId>.json`，内容 `{"preset":"...","compaction":"..."}`，两字段都以 `''` 表示"没选"。
- 会话 id 白名单：`/^[a-z0-9][a-z0-9_-]*$/`，长度 ≤128；`choicePath()` 再校验 `dirname === dir`，杜绝越界写。
- 写：先写临时文件再 `rename`（原子），失败清理临时文件。
- **没有内存缓存**（这是特意改的）：每次组装都读文件，和正文 `describe()` 的做法一致，这样手工编辑文件下一步也生效。
- 读损坏文件：`read()` 抛 `SessionChoiceError('unreadable')`；`effective()` 吞掉异常返回"没选"（组装路径永远不因它失败）。
- `prune(keep = 200)`：超过 200 个按 mtime 从旧到新删；每次 `write()` 后调用。
- `status()` → `{ dir, count, writable }`。

### 4.2 `src/index.ts`

- 引入 `SessionChoices`，在 `store` 附近创建：`const choices = new SessionChoices(resolveStoreDir(config))`。
- 删掉了全局状态：`let activePreset` / `setActivePreset()` / `presetReported`（boolean）→ 换成
  - `let presetList: PromptPreset[]`（缓存的组合列表）+ `refreshPresets()`（在 settings `sync()` 和挂载末尾调用，原来 `setActivePreset(resolved)` 的两处调用点已改成 `refreshPresets()`）；
  - `let presetReported = ''`（"组合不存在"报告去重用的签名）；
  - `presetInForceFor(sessionId)`：`choices.effective(sessionId).preset` → 查 `presetList`；找不到就按"每条自己的开关"并 warn 一次（消息里含那个 id）；
  - `sessionIdOf(context)`：结构化读取 `context.agent.session.id`（**不 import `@deepseek-ai/dsh-agent`**，避免加依赖）。
- 段落注册：`text: (context) => render(sessionIdOf(context), entry.id)`（原来是 `text: () => render(entry.id)`）。
- `render(sessionId, id)`：`const preset = presetInForceFor(sessionId); const on = preset === undefined ? entry.enabled : preset.entries.includes(entry.id)`。
- `resolveCompaction(sessionId)`：`const wanted = choices.effective(sessionId).compaction`（原来读根 `compaction` 字段 / 组合自己的字段）。
- `reportDanglingMembers()` 重写：现在遍历 `presetList` 里**每一个**组合（以前只看生效的那个），用 `const danglingReported = new Set<string>()`（原来是 `let danglingReported = ''`）按"每个组合一个签名"去重，消息里点名组合 id。
- 路由宿主多传一个字段：`installPromptRoutes(ctx, { store, sessions: choices, describe, ... })`。

### 4.3 `src/compaction.ts`

- `resolve(sessionId: string | undefined)` 签名改了一个参数。
- `llm/stream` 监听里新增：`const sessionId = typeof request['sessionId'] === 'string' ? request['sessionId'] : undefined`，然后 `host.resolve(sessionId)`。
  （DSH 的压缩引擎 `dsh-compaction-basic` 传的是 `sessionId: agent.session.id`，所以这里有值。）

### 4.4 `src/routes.ts`

- 新增 `handleSession(host, method, tail, request, response)`（追加在文件末尾）+ `errorCodeOf()`。
- 路由：`GET /dsh-prompt-manager/session/<id>` → `{ session, preset, compaction, stored }`；
  `POST /dsh-prompt-manager/session/<id>` body `{preset?, compaction?}`（合并写，值必须 `''` 或合法 id，否则 400）；
  `DELETE /dsh-prompt-manager/session/<id>` → 清掉（连同 `cleared`）。
- 分发表里插在 `variables` 之前：`if (head === 'session' && tail.length > 0) { await handleSession(...) }`。
- `PromptRouteHost` 新增**必填**字段 `sessions: SessionChoices`（注意：`test/routes.mjs` 的 host stub 必须补上，否则测试起不来）。
- `/status` 新增 `sessions: host.sessions.status()`。

### 4.5 `client/client.js`

- 新 hook：`useCurrentSession()`（读 `ctx.get('sessions').list` 的 `getSnapshot().current` + `subscribe`）~~、`useSessionChoice(sessionId)`~~ —— **`useCurrentSession` 已在 3.2.2 删除，见 §0**；`useSessionChoice(sessionId)`（`GET/POST /session/<id>`，写回服务端返回的 stored choice）保留；常量 `EMPTY_CHOICE`、`failureText()`。
- 两颗芯片（`PresetChip` / `CompactionChip`）改成：`sessionId = useCurrentSession()` → `session = useSessionChoice(sessionId)` → 生效值来自 `session.value`；菜单项在 `sessionId === undefined` 时禁用；标题文案改成"本会话…（别的会话不受影响）"。（**3.2.2 起**：`sessionId = props.sessionId`，槽给的那个；`undefined` 分支随之消失 —— 严格 session 槽没这个 id 根本不会渲染。）
- 切组合时一起写压缩指令：`session.write({ preset: id, compaction: picked.compaction })` —— 保留原来"组合整体切换"的语义。
- 设置页撤掉的入口：组合页 ⋯ 菜单的"设为当前/取消当前"、条目行里压缩条目的"设为当前/取消当前"、压缩编辑器里那颗"设为当前"按钮、"当前组合生效中"横幅（换成一句说明）、两处"组合：注入/不注入"标注（换成 `[]`）；`injected` 重新定义为"这条自己的开关"。
- 插件 `inject` 变 `['slots', 'settingsScope', 'sessions']`。（**3.2.2 起**改回 `['slots', 'settingsScope']`，见 §0。）
- `package.json` 的 `dsh.client.inject` 加了 `"@deepseek-ai/dsh-api-session-controller"`（`sessions` 服务的提供者就是它的客户端半边）。（**3.2.2 起**去掉，同上。）

### 4.6 `test/smoke.mjs`（部分改完）

- harness：新增 `const SESSION = 'session-harness'` 与 `choose(sessionId, patch)`（直接写 `STORE_ROOT/sessions/<id>.json`，注释里说明为什么不走路由）；`read(sessionId = SESSION)` 改成 `ctx.systemPrompt.assemble({ agent: { session: { id: sessionId } } })`。
- 组合相关的测试用例已改成 `choose('session-preset', { preset: '...' })` + `driven.read('session-preset')`；settings 文档里的 `activePreset` 已删掉。
- **还红着一处**，见 §5。

### 4.7 `README.md`（部分改完）

- `{{cwd}}` 那两处错误陈述已改：现在写明 DSH 自己注册了 `{{cwd}}/{{provider}}/{{model}}`（逐会话解析），本插件不能同名注册，正文里可以直接用，编辑器把它标成"未注册"是误报。

## 5. 当前唯一的红点（下一步先修这个）

命令与结果：

```
cd /f/环境/dsh-ctf-prompt && npm run build && node test/smoke.mjs
→ AssertionError: actual: 0, expected: 1
```

**诊断（已确认）**：`src/index.ts` 里我重写的 `reportDanglingMembers()` 把 `misplaced` 从 `missing` 里筛出来的，但语义上 `misplaced` 指的是"**在索引里存在、但它是压缩条目**"的成员 —— 这种成员根本不在 `missing` 里，所以永远筛不到，于是那条"组合里有压缩指令当成员"的告警不再发出（测试期望 1 条）。

**修法**：

```ts
for (const preset of presetList) {
  const members = preset.entries
  const absent = members.filter((id) => !byId.has(id))
  const misplaced = members.filter((id) => byId.get(id)?.kind === 'compaction')
  const signature = `${preset.id}:${absent.join(',')}:${misplaced.join(',')}`
  if (danglingReported.has(signature)) continue
  danglingReported.add(signature)
  if (absent.length === 0 && misplaced.length === 0) continue
  // 一条 warn，消息里必须包含 preset.id 与出问题的 member id（测试就是这么断言的）
}
```

测试断言的原文（`test/smoke.mjs`）：
- `dangling.length === 1`，`dangling[0].includes('partial')`（成员 `renamed-away` 不在索引里 → 报一次，且点名组合）；
- `misplaced.length === 1`（成员 `compact-zh` 在索引里但是压缩条目 → 报一次）。

## 6. 还没做的（建议顺序）

1. **修 §5 的 bug**，然后 `npm run build && node test/smoke.mjs` 直到绿。
2. **`test/compaction.mjs`**（2 处 `activePreset` 引用）：它的 harness 大概也 `assemble({})`，需要像 smoke 一样传 `{ agent: { session: { id } } }`，并把"用哪条压缩指令"改成写会话文件。
3. **`test/routes.mjs`**：`PromptRouteHost` 现在多了必填 `sessions`，host stub 里补一个 `new SessionChoices(<临时目录>)`。（可以顺手给 `/session/<id>` 的 GET/POST/DELETE 加几条断言 —— 用户说不用新增测试，所以最低要求是让它能跑起来。）
4. **`test/client.mjs`**（28 处 `activePreset` 引用）：它的 harness 需要
   - 提供 `sessions` 服务假实现（`{ list: { getSnapshot: () => ({ current: 'session-x' }), subscribe: () => () => {} } }`），因为客户端插件 `inject` 现在要它；
   - 让假 `fetch` 处理 `GET/POST /dsh-prompt-manager/session/<id>`（返回 `{session,preset,compaction,stored}`）；
   - 把断言从"写了 `activePreset`/`compaction` 字段"改成"打了 `/session/<id>` 的请求、body 是 `{preset,compaction}`"。
5. **README 剩下的部分**：
   - 开头第 11–16 行那张"什么存在哪、谁在改"的表：加一行"哪个组合/哪条压缩指令生效 → `<storeDir>/sessions/<id>.json` → 会话输入框那行的芯片"；
   - 第 119–130 行「组合」：把"切换是全局的（写 `activePreset`，所有会话都跟着变）"整段改掉；"两个入口"里设置页那条改成"设置页只编辑组合内容"；
   - 第 105–117 行「压缩指令」：指针的三种写法（根字段/组合自己的字段）要改成"会话文件里的 `compaction`"；"设为当前/取消当前"的说法全部换成"在会话的「压缩」芯片里选"；
   - 第 91–103 行「设置页」：删掉"组合：注入/不注入"标注的说明；
   - 新增一小节说明：**每会话选择**（文件位置、JSON 形状、上限 200、默认=不用组合/不用自定义指令、`/status` 的 `sessions` 字段、`GET/POST/DELETE /dsh-prompt-manager/session/<id>`）；
   - 说明 `settings.yaml` 里 `prompt-manager.activePreset` 与根 `compaction` **保留但不再决定任何事**（只为旧文件能通过校验）。
6. **版本号**：`3.1.9` → `3.2.0`（行为变更）。用 `npm version minor --no-git-tag-version`（会改 package.json；`package-lock.json` 里的版本字段也要跟着，`npm version` 会一并处理）。
7. **客户端零碎收尾**（可选但建议）：
   - `client/client.js` 里还有一处错误提示文案提到「设为当前」（约 1227 行，`正文和索引都写好了，但「设为当前」没写进去…`）；
   - 现在**死掉但不报错**的代码：`activatePreset`、`setCompaction`、`compactionLocked`、以及"新建压缩指令时顺手把它设为当前"那条流程（仍然往已经没人读的根字段写）。要么删掉，要么在注释里说明它已失效。
8. **构建 + 全绿 + 提交 + 推送**：
   ```
   cd /f/环境/dsh-ctf-prompt
   npm run build            # lib/ 必须等于 src/ 的新鲜构建（check:build 会验）
   npm run typecheck
   npm test                 # 必须全绿
   node tools/check-build.mjs
   npm run check:pack
   git add -A && git commit -m "feat(choice): 组合与压缩指令按会话隔离，落盘、默认不选"
   git tag v3.2.0
   git push origin main --follow-tags      # 触发 ci.yml 与 release.yml
   ```
   `release.yml` 的闸门（务必满足）：`npm ci` → `npm run build` → `npm test` → `node tools/check-build.mjs` → `npm run check:pack` → **tag 必须等于 package.json 的 version** → `npm publish --provenance --access public` → `gh release create`。
   远程：`https://github.com/lolkda/dsh-prompt-manager.git`。
9. **发布后的验收**（用户已同意这个方式）：
   - 装上新版（`dsh plugin --profile web add @lolkda/dsh-prompt-manager@3.2.0` 或 profile 里升级），重启 profile；
   - 开两个会话：A 里切组合 → A 变、B 不变；A 里换压缩指令 → 只影响 A 的下一次压缩；
   - 重启 DSH → A 的选择还在（`~/.dsh/prompt-manager/sessions/<A的会话id>.json`）；
   - `curl -s http://127.0.0.1:3080/dsh-prompt-manager/status` 看 `sessions: {dir,count,writable}`。
   - **宿主侧现在就能手工验**：往 `~/.dsh/prompt-manager/sessions/<会话id>.json` 写 `{"preset":"codex","compaction":""}`，只有那个会话会变成 codex 组合。

## 7. 调研结论（省得重新查，都验证过了）

- **段落文本可以是 provider**：`PromptSection.text: string | ((context: AssembleContext) => string)`；`@deepseek-ai/dsh-agent` 用 `declare module` 给 `AssembleContext` 补了 `agent?: Agent`，运行期 `assembleContextFor()` 传的是 `{ agent, scope: agent, signal? }`。→ 段落里能拿到 `agent.session.id`。
- **`llm/stream` 的 options 带 `sessionId`**（`GenerateOptions.sessionId`），压缩引擎传的是 `agent.session.id`。→ 压缩缝隙也能按会话。
- **DSH 自己注册了 `{{cwd}}` / `{{provider}}` / `{{model}}`**（`dsh-agent-loop/lib/index.js:1534-1536`：`ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd)`）。本插件**不能**再注册同名（同层重名抛错，跨层会被遮蔽）。
- **settings 是部署级**：`SettingsScope<T>` 只是"一个命名空间的 owner 句柄"，层序 = 默认值 → 组合 base → 用户层，没有 per-session 层。
- **不能用 agent presets 做这件事**：preset 决定会话的工具与提示词，**只在 agent 还没产出任何东西时**才能换（`dsh-agent-presets` 明写），它的芯片是"暂存到下一个会话生效"。所以必须插件自己存 per-session 状态。
- ~~**客户端怎么拿当前会话 id**：服务名 `sessions`（由 `@deepseek-ai/dsh-api-session-controller` 的客户端半边 `provide("sessions", ...)`），`sessions.list` 是快照 store，`.current` 就是当前会话 id（`dsh-client-ui-conversation` 里就是这么读的）。~~ **错，见 §0**：`current` 在 `0.1.6-alpha.2` 已被删除，这条路会让芯片拿到 `undefined`。
- ~~composer 槽 `conversation.input.right` 虽然声明成 `scope: "session"`，但宿主 `renderSlot(name, {})` **不把 sessionId 交给注册方**，所以芯片必须自己去读 `sessions`。~~ **错，见 §0**：`renderSlot` 的 owner props 与框架的 standard kit 是两套 share；`scope: "session"` 的槽会给每个条目注入 `sessionId` 属性。
- **本轮不再依赖的先例**：`SessionHeader.cwd` 是会话创建时冻结的绝对路径（`{{cwd}}` 的值来自它）。

## 8. 环境与工具注意

- 仓库：`F:\环境\dsh-ctf-prompt`（git bash 里 `/f/环境/dsh-ctf-prompt`）。DSH 本体 **0.1.6-alpha.1**；`@deepseek-ai/*` 包在 `$APPDATA/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 与 `~/.dsh/profiles/node_modules/@deepseek-ai/`。
- 工作区里有一个未跟踪文件 `thinking-effort-loaded.json`（`@hytime/dsh-thinking-effort` 挂载时落的标记），别提交。
- `lib/` 是**提交进仓库的构建产物**，改完 `src/` 一定要 `npm run build`，否则 `check:build` 会失败。
- 工具坑（我踩过）：
  - `replace` 工具的**替换文本**里 `$` 必须写成 `$$`（否则被当作捕获组引用）；**pattern** 里如果想匹配字面 `${x}` 就写单个 `$`；含 `{` / `}` 的正则要用 `literal: true` 或转义。
  - 长会话里工具输出会被压缩（只显示首尾若干行）——读文件请用小窗口（`sed -n 'a,bp' | head -12`）、或改用 `grep` 的 content 模式带 context。
- 用户偏好看**大白话**汇报，别堆术语。

## 9. 开放问题

1. ~~**局域网只读**~~ —— **已定：交还信任判定（方案 A）。** 原先路由自己判"对端必须 loopback"，比宿主还严：装了 `@lolkda/dsh-web-lan` 之后 `/api` 通、这条路由不通，于是从别的设备打开时**不是只读，而是整个存储不可达**（设置页显示"正文目录不可写"、四个计数全 0，还把服务端那句英文原文糊在中文页面上）。现在改成：本机对端照旧（Host 必须本机名，挡 DNS rebinding；**不要求会话**，README 那条 curl 自检靠它），其它对端交给 `connection.requestRejection` —— 和 `/api` 同一把尺子，写操作仍要 same-origin。理由：能拿到浏览器会话的页面本来就能通过 `/api` 改设置、切权限、跑会话，插件不额外加宽；客户端同时改成"读不到"就说读不到（不再捏一个假 store，也不再拿读失败断言"压缩指令已关闭"）。
2. `settings.yaml` 里那两个已经不决定任何事的字段（`activePreset`、根 `compaction`）要不要在下个大版本删掉（会需要迁移）。
3. 客户端里那些**已失效但仍在写**的死代码（见 §6.7）是删掉还是留注释。
