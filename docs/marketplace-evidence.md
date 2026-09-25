# 商城上架证据（手工实测记录）

DSH STORE 的上架契约（`build-dsh-plugin/references/marketplace.md`）把这些证据分成若干道门。
这份文件记录本仓库**实际跑过**的结果，以及**没跑过**的部分 —— 没跑的一律保持 `unknown`，
不推测、不用范围声明顶替。对应 `package.json` 的 `dsh.compatibility.dshOperations`。

## 环境

| 项 | 值 |
|---|---|
| 测量时间（UTC） | 2026-09-13T04:08Z |
| `dsh --version` | 0.1.5-rc.1 |
| Node | v24.18.0 |
| pnpm | 12.3.4 |
| 被测包 | `@lolkda/dsh-prompt-manager` 3.1.5（rollback 目标 3.1.4） |

## 一、包（Package gate）

| 门 | 命令 | 结果 |
|---|---|---|
| 测试 | `npm test` | **exit 0**，13 个测试套件全绿 |
| 构建一致 | `npm run check:build` | **exit 0** —— `lib/` 是 `src/` 的新鲜构建，且其中每个文件都已跟踪 |
| 打包内容 | `npm run check:pack` | **exit 0** —— `58 files, 185.5 kB, bundle patch cordis.patch.yml present` |

## 二、DSH 兼容（DSH compatibility gate）

一次性 profile 的四步矩阵，**全部在隔离的 `DSH_HOME` 里做**：

- `DSH_HOME=D:/Personal/Temp/pmcheck-home` —— 独立 home，settings、会话、提示词数据都与真实环境分离；
- profile `pmcheck` 由内置模板新建：`dsh --profile pmcheck --from-default-profile web --dump-config`；
- 真实环境（profile `web`）**全程未被触碰**：测前测后 `http://127.0.0.1:3080/dsh-prompt-manager/status` 都是 `200`。

> 绕开 pnpm 的 24 小时供应链冷却期：新 profile 的 `pnpm-workspace.yaml` 里先写入
> `minimumReleaseAgeExclude`，否则 pnpm 会**静默回退**到够旧的那个版本，装到的就不是被测版本。
> 这是本次实测中真实踩到的坑（在真实 profile 上表现为装成 3.0.0 而非 3.1.5）。

### 1. install —— `passed`

```bash
dsh plugin --profile pmcheck add '@lolkda/dsh-prompt-manager@^3.1.5'
```

观察：`+ @lolkda/dsh-prompt-manager 3.1.5`；包**自动**进入 `dsh.profile.bundles`
（`@deepseek-ai/dsh-base @deepseek-ai/dsh-web-app @lolkda/dsh-prompt-manager`）；
`dsh --profile pmcheck --dump-config` 里出现且只出现**一行** `- id: dsh-prompt-manager`。

### 2. start —— `passed`

```bash
dsh --profile pmcheck --no-open --port 0        # 冷启动，OS 选空闲端口
# -> dsh web: http://127.0.0.1:50637/?token=…
```

观察：进程冷启动成功；`GET /dsh-prompt-manager/status` → **200**；返回体里
`variables` 解析出 **13 个**（含 `bash: "5.3.15"`、`node: "24.18.0"`）；
`dir` 指向**隔离 home** 的 `…\pmcheck-home\prompt-manager\sections`；
应用根路径无 token 401、带 token 303（认证链路正常）。验证后停掉该实例。

### 3. rollback —— `passed`

```bash
dsh plugin --profile pmcheck add '@lolkda/dsh-prompt-manager@3.1.4'   # 回退到上一版
dsh --profile pmcheck --no-open --port 0                              # -> http://127.0.0.1:50751/
```

观察：版本降级到 3.1.4，`--dump-config` 仍是一行；冷启动成功，`/status` → **200**，
变量照旧解析。验证后停掉。

### 4. uninstall —— `passed`

```bash
dsh plugin --profile pmcheck remove @lolkda/dsh-prompt-manager
dsh --profile pmcheck --no-open --port 0                              # -> http://127.0.0.1:50842/
```

观察：`- @lolkda/dsh-prompt-manager 3.1.4`；`node_modules` 下该包消失；
`bundles` 回到 `@deepseek-ai/dsh-base @deepseek-ai/dsh-web-app`（= 安装前状态）；
`--dump-config` 里 `dsh-prompt-manager` 出现 **0** 次；冷启动仍然成功
（应用根路径 401 = 认证挑战，说明 app 健康），而插件路由 → **404**，确认卸干净。
验证后停掉。

## 三、没测的部分（这些一律保持 `unknown`）

- **0.1.5-alpha.2 与 0.1.5-rc.2 的四项操作：没跑。** 本机装的是 0.1.5-rc.1，没有对另两个版本
  做过任何安装/启动/卸载/回滚，因此 manifest 里如实写 `unknown`。要变成 `passed` 需要在对应
  版本上真跑一遍同一套矩阵。
- **UI 层只做了 HTTP 冒烟**：路由可达、认证挑战、变量解析。浏览器里的点击级验收（设置页各页、
  对话框 chip、压缩替换是否真的生效）**没有**自动化记录在这里。
- **安全审计**：没有做。本文件不是安全审计，`assurance.securityReview` 保持 `unknown`。
- **独立安装验收**：没有第三方复现过上述矩阵。

## 四、怎么复现

```bash
export DSH_HOME='<一个空目录>'
dsh --profile pmcheck --from-default-profile web --dump-config
# 在 $DSH_HOME/profiles/pmcheck/pnpm-workspace.yaml 追加 minimumReleaseAgeExclude 后：
dsh plugin --profile pmcheck add '@lolkda/dsh-prompt-manager@^X.Y.Z'
dsh --profile pmcheck --dump-config | grep -c 'id: dsh-prompt-manager'
dsh --profile pmcheck --no-open --port 0        # 另开一个终端 curl /dsh-prompt-manager/status
dsh plugin --profile pmcheck remove @lolkda/dsh-prompt-manager
rm -rf "$DSH_HOME"
```

**这份记录不是商城收录证明。** 契约自己写着：只有合并后的 `catalog.json` 与公开商城页面这两道门
才算实际上架。本文件只覆盖其中"包"与"DSH 兼容"两道里**可以自己跑出来的那部分**。
