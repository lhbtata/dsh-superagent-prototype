# SETUP-NOTES — Super-agent 研究原型本机部署说明

> 记录 `deepseek-ai/dsh-superagent-prototype` 在本机（Ubuntu 24.04.5 LTS）的部署细节、约定与踩坑。
> 整理日期：2026-11-25。
> **本文件不含任何密钥**：面板 token、GitHub token 等一律以占位符（`<PANEL_TOKEN>`）表示。
> **面板地址口径**：对外/入文档一律只写 `http://127.0.0.1:3082`，不带 `?token=` 实参；token 只在本机启动日志里就地取用（§2），不进文档、不进 git、不贴进对话。

## 1. 组件位置

| 组件 | 位置 |
|---|---|
| 官方仓库克隆 | `/home/ps/src/dsh-superagent-prototype`（origin=上游 deepseek-ai，本机 fork 远端 `fork`=lhbtata/dsh-superagent-prototype；本地 main 已与 fork/main 同步） |
| 本机 fork | `lhbtata/dsh-superagent-prototype`（上游关闭了 issue 与 PR，改动落在 fork：脚本修复 PR #1、本文件 PR #2，均已并入 fork/main） |
| 靶场仓库（GitHub） | `lhbtata-superagent/superagent-sandbox`（公开，agent 账号自持） |
| 靶场本地克隆 | `/home/ps/src/superagent-sandbox`（executor prepare 的 fetch 基础） |
| DSH profile | `~/.dsh/profiles/superagent`（机器配置在其 `cordis.patch.yml`） |
| 状态目录 stateDir | `/home/ps/.dsh/state/superagent`（orchestrator.sqlite、worker-bin/、worker-gitconfig） |
| agent GitHub CLI | `/home/ps/.local/bin/gh-agent`（`GH_CONFIG_DIR=~/.config/gh-agent`，登录 `lhbtata-superagent`） |
| agent 飞书 CLI（bot 专用） | 配置目录 `~/.lark-cli-dsh-superagent`；wrapper `/home/ps/.local/bin/lark-bot`（见 §5） |
| 飞书工作群 | `oc_167db7fc1fc970bcf8716e2616f1a3a6`（群名「dsh-agent组1」，bot 为群主/管理员） |
| 服务管理脚本 | 仓库内 `scripts/dsh-superagent` |

## 2. 管理面板与服务管理

- 面板地址：`http://127.0.0.1:3082`（对外只写这个地址；访问时所需 token 用 `<PANEL_TOKEN>` 表示）。
  - token 由服务启动时随机生成，打印在启动日志**首行**：`/home/ps/src/dsh-superagent-prototype/.artifacts/dsh-superagent-superagent-*.log`（保留最近 20 个）。
    该目录已被 `.gitignore` 忽略（`.gitignore:3:.artifacts/`），**不会进入仓库、不会被提交/推送**；历史日志中的 token 已就地脱敏为 `<PANEL_TOKEN>`。
  - 重启服务会重新生成 token（旧值立即作废）；无 token 访问返回 401。
  - 需要自取 token 时（例如调管理 API）：从最新日志首行读出后**留在本机 shell 变量里使用**，不要 echo、不要写进文档或对话：
    ```sh
    TOK=$(grep -oE 'token=[A-Za-z0-9_-]{20,}' "$(ls -t .artifacts/dsh-superagent-superagent-*.log | head -1)" | head -1 | cut -d= -f2)
    curl -H 'x-orchestrator-request: 1' "http://127.0.0.1:3082/orchestrator/api/state?token=$TOK"
    unset TOK
    ```
  - 面板与管理 API **仅本机可达**：API 校验 `Host` 必须是 `127.0.0.1/localhost` 且请求头带 `x-orchestrator-request: 1`，走局域网反代会被 403。
- 管理 API：`http://127.0.0.1:3082/orchestrator/api/`（state / overview / tickets / settings / decisions / threads…），均需 `x-orchestrator-request: 1` 头。
- 服务管理（在仓库根目录执行）：
  ```sh
  python3 scripts/dsh-superagent status  --profile superagent   # exit 0=正常 1=未跑/运行错误 2=组件错误 3=等设置
  python3 scripts/dsh-superagent start   --profile superagent
  python3 scripts/dsh-superagent stop    --profile superagent
  python3 scripts/dsh-superagent restart --profile superagent
  ```
  服务跑在 tmux 会话 `dsh-superagent` 里（进程 `dsh --profile superagent --no-open`）。
  - **工单收尾时可能出现一次残留错误**：`health.worker=error`（`AggregateError: Stopping the background work of worker-<ticket> failed`），`status` 退出码变 2。
    - 触发点：某个工单的派工结束。外部合并 PR 之后最常见，但派工自己收尾也会触发——本机在 PR #4 还没合并时就出现过一次（2026-11-25 16:47）。它是会话收尾时的报错残留，不影响已完成的工单，只会让面板 Overview 挂着一条 problem。
    - 来源：`src/executor/background.ts:159-165` 的 `stopBackground()` 把「杀不掉的后台 job / 释放不了的 subagent」包成 `AggregateError`，`src/executor/dsh.ts:539-542` 的 `background()` 把它写进 `worker` 健康项。`String(error)` 只显示外层文案，真正的子错误在 `AggregateError.errors` 里、面板与日志都不展开，所以面板上看不到根因。
    - **处理：`python3 scripts/dsh-superagent restart --profile superagent`**（重启后 exit=0、health 十项全 ready；工单与历史留在 `orchestrator.sqlite` 里，不会丢）。仓库里的进程识别修复（见 §6）是这条处置能落地的前提——修复之前 `stop`/`restart` 找不到服务进程，残留错误就一直挂着。

## 3. 账号模型（路线 A）

- 操作者账号：`lhbtata`（本机主账号，提需求的人）。
- agent 账号：`lhbtata-superagent`（agent 身份；PR 提交以该账号 author/committer 署名）。
- 仓库归属：**靶场仓库在操作者账号 `lhbtata` 名下（私有）**，agent 账号 `lhbtata-superagent` 作为 **collaborator（push，无 admin）** 参与。
  - 这是官方推荐形态：`SETUP.md` 第 2 问指定 owner/name 仓库、第 3 问要求「专用账号，绝不用操作者本人账号」，第 67 行的 operator steps 包含「以 agent 账号接受仓库邀请」；`docs/006-deployment.md` 也写明「给 agent 建一个 GitHub 用户账号并授予该仓库写权限」。
  - 2026-11-26 已从旧形态（仓库在 agent 账号名下、公开）切过来：`gh api -X PUT repos/lhbtata/superagent-sandbox/collaborators/lhbtata-superagent -f permission=push` → 201（invitation 346440054），再由 agent 账号 `gh-agent api -X PATCH user/repository_invitations/346440054` 接受。
  - 好处：agent 账号**没有 admin**，不能改仓库设置（成员、可见性、分支保护、删仓库）。⚠️ 但**它仍然能合并自己的 PR** —— GitHub 上 write(push) 权限即可合并，admin 不是前提（PR #3 实测 `merged_by = lhbtata-superagent`）。旧形态下 agent 自持仓库有 admin，能自改设置、更危险。要真正做到「必须人合并」请给 main 开分支保护（§11.6）。
  - 旧仓库 `lhbtata-superagent/superagent-sandbox`（已转 private、agent 自持）是切换前的遗留，处置见 §11.5 / §11.7。
- `gh-agent` 与操作者的 `gh` 凭据目录完全独立（`~/.config/gh-agent` 与 `~/.config/gh`）。
- worker 的 git 凭据走 stateDir 下自动生成的 `worker-gitconfig`（credential helper 指向 `gh-agent`，SSH 强制转 HTTPS），与操作者本机 git 配置隔离。
- 换 agent 账号时只需：`GH_CONFIG_DIR=~/.config/gh-agent gh auth login`，然后面板 Sources 重存一次触发 setup 重校验。

## 4. 模型与运行配置

- LLM（写在 `~/.dsh/profiles/superagent/cordis.patch.yml`，从 web profile 抄来）：
  - `minimax-cn`（`apiKeyEnv=MINIMAX_CN_API_KEY`），默认模型 `MiniMax-M3.1-Flash`；
  - `vllm-local`（`baseURL=http://192.168.0.102:18000/v1`，模型 id `/models/awq`）；
  - `agent-default-model = minimax-cn / MiniMax-M3.1-Flash`。
  - 面板里 eval.model / executor.model 均为 null → 回落到 agent-default-model。
- GitHub Source：repository `lhbtata/superagent-sandbox`（操作者名下、私有），cli `/home/ps/.local/bin/gh-agent`，pollSeconds 60，observe* 全关（仅 @ 提及触发）。
- Policy：allowed = `lhbtata`（只有操作者能发起）；rules 为默认 copy / visual 两条；飞书源另有一份 allowed（按**应用级** open_id，见 §5.8）。
- Executor：maxWorkers 3，工作目录 `/home/ps/.dsh/state/superagent/work`，prepare =
  `git -C /home/ps/src/superagent-sandbox fetch --no-tags <repo>.git <pr-head>:refs/dsh-superagent/<ticket> && git worktree add -b agent/<name> <dir> ...`
  blockedCommands 空。
- eval mode = `observe`（默认；显式请求照常执行，inferred 候选只记录「would accept」）。
- 飞书 Source：**已接通**（bot 身份，只在指定群里响应 @ 提及）。配置细节与踩坑见 §5。

## 5. 飞书接入全流程（Feishu Source）

本节是「把 Super-agent 接到飞书」的可复现步骤，按顺序走即可；坑记在末尾。

### 5.1 为什么必须新建独立应用 + 独立配置目录

- 官方要求（`docs/006-deployment.md:49-69`）：给 bot 一份**独立配置目录 + strict mode 只允许 bot 身份**的 lark-cli。
- 不能复用个人 CLI 的配置：`lark-cli` 一个 app id 只允许一个 profile；个人配置里可能已有该 app 的 user 登录态；两个配置共享 keyring 里的 app secret；删 bot 配置要直接删目录，**不要跑 `lark-cli config remove`**（会动到共享 secret）。
- 不能复用旧应用的 open_id：**open_id 是应用级的**，同一个用户在不同应用下 open_id 不同。

### 5.2 建应用（浏览器一步）

```sh
# 独立配置目录 + 后台创建应用，浏览器完成授权
LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" \
  lark-cli config init --new --name superagent-bot
```

- 该命令会打印浏览器链接（形如 `https://open.feishu.cn/page/cli?user_code=XXXX-XXXX`）并**阻塞等待**在浏览器完成配置；应放后台跑，日志留在本地。
- 完成后输出 `OK: 应用配置成功! App ID: cli_xxxxxxxx`，配置写入 `~/.lark-cli-dsh-superagent/config.json`（0600，`appSecret` 只显示 `****`，**不要去取明文**）。
- 本机结果：app id `cli_ab8c1481eba39d1c`，bot open_id `ou_9e4c73b1e5c096278531569d9fa4a64d`。
  - 应用名**已在开发者后台改为「Super-agent」**（2026-11-26）。改名前它叫「刘海宾的飞书 CLI」，与个人 CLI 应用同名，@ 时按名字搜容易混淆。**改名不影响 open_id**，policy 里的 allowed 不用动。
  - 改名后需 `restart` 才能让 host 侧缓存的 bot 名刷新（`setup.accounts.feishu.name` 与面板 `facts.cli`）——实测重存 source 块**不会**刷新，重启才会。

### 5.3 strict mode 只允许 bot 身份

```sh
LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
```

`lark-bot auth status --json` 应显示 bot ready、**没有** user 登录态（user missing 才是对的）。host 侧若发现能以用户身份行动的 CLI，会报 `feishuUserIdentity`（`src/setup.ts:17-20`）。

### 5.4 wrapper

`/home/ps/.local/bin/lark-bot`（0755）：

```sh
#!/bin/sh
export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
exec lark-cli "$@"
```

worker 的 `stateDir/worker-bin/lark-cli` shim 会指向这个 wrapper（`src/infra/environment.ts:101`）。

### 5.5 建群并把 bot 放进去

```sh
~/.local/bin/lark-bot im +chat-create --name "dsh-agent组1" \
  --description "Super-agent 专用群：@机器人提需求" \
  --type private --chat-mode group --set-bot-manager --as bot
```

- 输出里的 `chat_id` 就是后面要填的群；bot 自己是群主/管理员，**不需要**再邀请。
- 本机群：`oc_167db7fc1fc970bcf8716e2616f1a3a6`。
- 群成员可用 `im +chat-members-list --chat-id <chat> --member-types user,bot --as bot` 核实（本群：1 user + 1 bot）。

### 5.6 在 profile 里启用插件

`~/.dsh/profiles/superagent/cordis.patch.yml` 追加：

```yaml
plugins:
  - id: dsh-superagent-feishu
    disabled: false
```

### 5.7 面板接线（注意 source 块的位置）

- `GET /orchestrator/api/settings` 返回 `{policyVersion, blocks:{policy,eval,executor}, sources:[...], environment}` —— **source 块不在 `blocks` 里，而在 `sources` 数组**；没有 `GET settings/<id>` 这种单块读接口（`GET settings/policy` 会报 Unknown operation）。
- 写入：`PUT /orchestrator/api/settings/source:feishu`，body `{"value":{"enabled":true,"config":{...}},"revision":N}`。

本机保存的配置：

```json
{"enabled": true,
 "config": {"cli": "/home/ps/.local/bin/lark-bot",
            "readPageSize": 20, "linkTimeoutMs": 5000,
            "chats": [{"chatId": "oc_167db7fc1fc970bcf8716e2616f1a3a6",
                       "name": "dsh-agent组1", "listen": "mentions"}],
            "directMessages": true, "otherChats": "none"}}
```

- `chats[].listen`：`mentions` = 只响应 @ 提及；`all` = 群里所有消息都进。
- `directMessages: true` = 私聊也收；`otherChats: none` = 不在配置列表里的群一律不收。

### 5.8 policy 里的接收名单（按应用级 open_id）

- feishu 源允许写 `{"id":"ou_…","name":"…"}`（`src/sources/feishu.ts:73`），**github 源不允许带 `name`**（strict schema，`src/sources/github.ts:72`），带了就报 `Unrecognized key: "name"`。
- 本机采用**显式白名单**：`sources.feishu.allowed = [{"id":"ou_301ab27830ae4e1d02dd77873e1afc9c","name":"刘海宾"}]`（这是刘海宾在**本应用**下的 open_id，与个人应用里的 open_id 不同）。**只有名单里的人能发需求**；群里其他人即使 @ 机器人，决策 reason 会是 `not_a_member`（`src/policy.ts:210`），不建单、不执行。
- **写整块 policy 时必须带完整的 `rules` 原样回填**：`rules[]` 的 schema 是 `{id, name, enabled, instruction}`，写 `kind` 会被拒（`Unrecognized key: "kind"`），漏字段也会被拒（`rules.0.id: expected string, received undefined`）。最稳的做法是 GET 一次 `settings`，把 `blocks.policy.value` 原样取出、只改 `sources` 里要动的字段再 PUT 回去。
- **syncChat（名单自动同步，可选，本机未启用）**：给 feishu 源填 `syncChat` = 群 chat_id，名单就会跟着群成员走（新成员进、离开的移除、名字取群里的名字），在启动时和点「立即同步」时执行；`POST /orchestrator/api/policy-sync/feishu` 会返回同步结果 `{"policy":{"allowed":[…],"syncChat":"oc_…","admission":{}}}`。
  - **风险**：一旦启用，**任何进入该群的人都自动获得发需求并驱动 agent 改仓库的资格**——只要 ta @ 机器人，决策不再是 `not_a_member`，而是当作获授权的需求处理。这与本机「只允许本人发起」的原则冲突，因此**本机保持 `syncChat` 为空**，用显式白名单。
  - 没填 `syncChat` 时调该接口会报 `nothingToSync`（`The feishu Source's part of the Policy has nothing to sync from`）——这是预期行为，不是故障。
  - 若将来确需开启，步骤：policy 里给 feishu 填 `syncChat` → `POST /orchestrator/api/policy-sync/feishu` → 复核 `allowed` 名单 → 并在本节同步写明「群成员自动获得需求资格」这一变化。

### 5.9 重启并验收

```sh
python3 scripts/dsh-superagent restart --profile superagent   # 插件需重启才生效
```

验收点：`status` exit=0；`GET /orchestrator/api/state` 的 `setup.problem = null`、`setup.accounts.feishu = {appId, brand, botId, name}`；`health.feishu = ready「Listening for bot events」`；`health.history = ready`。

### 5.10 飞书侧踩坑清单

| 坑 | 现象 | 处理 |
|---|---|---|
| open_id 是应用级的 | 用旧应用的 open_id 调 API → `99992361 … how-to-obtain-openid` | 用**本应用**下的 open_id；改应用名不影响 open_id |
| policy 名单为空 | 消息被收到但不建单，决策 reason = `not_a_member`（`src/policy.ts:210`） | 写 `sources.feishu.allowed` 后，对已有触发器 `POST /orchestrator/api/triggers/<id>/requeue` 才会重新评估 |
| 事件 JSON 顶层平铺 | 按 `event.sender.sender_id.open_id` 解析得到 null | 实际结构是**顶层** `sender_id`（即 open_id）、`mentions[0].id`（被 @ 的 bot open_id）、`chat_id`、`message_id`、`content` |
| 权限不足 | `99991672 app_scope_not_applied`；`+chat-members-list` 报缺 `im:chat`/`im:chat:readonly`/`im:chat.group_info:readonly`/`im:chat.members:read` | 开发者后台申请 scope 并**发布版本**；错误里带 `console_url` 可直接跳转。实际可用的最小集合见 §5.11 |
| `event consume` 超时参数 | `--timeout` 必须带单位（如 `8s`），否则报错 | 调试监听建议 `--max-events N --timeout 600s` |
| 两个同名应用 | 开发者后台出现两个「刘海宾的飞书 CLI」 | 不是故障原因（群里只有新 bot，@ 的 open_id 就是它），但 @ 时按名字搜容易混淆 → 把新应用改名「Super-agent」（本机已改，见 §5.2） |
| 直答不建单 | 自我介绍/闲聊类请求 → 决策 outcome=ignore、reason code=`said` | 预期行为：直接在原会话作答，不开工单 |
| 应用改名 | 改名后 `setup.accounts.feishu.name` 仍是旧名 | 需 `restart`（重存 source 块不刷新缓存的 bot 名） |
| `im:chat.group_info:readonly` 不存在 | 开发者后台搜不到这个权限 | 见 §5.11：群信息由 `im:chat` / `im:chat:readonly` 覆盖，不单独申请 |
| syncChat 与白名单语义冲突 | 填了 `syncChat` 后群里任何新成员都自动获得发需求资格 | 本机**不启用** syncChat，用显式白名单（只含本人 open_id），见 §5.8 |

### 5.11 权限清单（2026-11-26 实际申请并验证）

开发者后台给 `cli_ab8c1481eba39d1c` 申请并发布版本后，`lark-bot auth scopes --json` 显示 5 项：

```
offline_access, im:chat, im:chat.members:read, im:chat.members:write_only, im:chat:readonly
```

- **`im:chat.group_info:readonly` 在后台并不存在**，不需要申请——群信息由 `im:chat` / `im:chat:readonly` 覆盖。早期文档里把它列进必需清单是照抄了错误提示文本，实际申请时按 `im:chat` 即可。
- 验证（权限生效后全部通过）：
  - `im +chat-members-list --chat-id <chat> --member-types user,bot --as bot` → 正常返回 1 user + 1 bot；
  - `im +chat-list --as bot` → 正常返回所在群；
  - `POST /orchestrator/api/policy-sync/feishu` → 同步成功（见 §5.8 的 syncChat）。
- 仍不可用的（需要额外权限或换做法）：把 bot 主动拉进**别的**群（`im:chat.members:write_only` 只覆盖 bot 所在租户的成员管理，跨群拉 bot 需在群里由管理员添加）。
| 应用改名/换号后 | 旧的 allowed 里的 open_id 失效 | 重新用 `event consume` 抓本应用下的 open_id 并更新名单 |

## 6. 本地补丁（升级时必须保留）

`scripts/dsh-superagent` 的**服务进程识别**已改写（2026-11-25）。上游用 `name in ('node','dsh')` 匹配 `ps` 的进程名，而本机 `ps -o ucomm=` 对 node 进程报告 `MainThread`（Node.js 改名主线程所致，`comm` 同样是 `MainThread`），于是上游过滤永远不命中，`status`/`stop` 判定「服务没在跑」——`restart` 因此不可靠，组件级残留错误（如 `health.worker=error`）就清不掉。

改法（已并入本机 fork `lhbtata/dsh-superagent-prototype` 的 `main`，PR #1 `fix/superagent-service-process-detection`；本地工作区已同步）：

```python
PROCESS_NAMES = ('node', 'dsh')


def dsh_service(name, args):
    """Return whether a process looks like the DSH service.

    The process name alone is unreliable: Node.js renames its main thread, so hosts report the
    service as "MainThread". The DSH entry point in the arguments identifies it as well, but only
    when it is the program itself or the script behind the interpreter, so that a launcher's own
    command line (the tmux server, a shell) is not mistaken for the service.
    """
    if name in PROCESS_NAMES:
        return True
    return any(os.path.basename(word) in ('dsh', 'dsh.js') for word in (args or [])[:2])
```

- `running()` 与 `processes()` 两处改用 `dsh_service(name, args)`。
- **只看前两个词**：服务进程的命令行是 `node /path/to/dsh --profile …`；tmux server 的命令行里同样含 dsh 路径，但它在第 ~15 个词——按整条命令行匹配会把 tmux server 误判成服务进程（实测 `status` 会多报一个 pid 并以 1 退出）。所以「dsh 入口必须出现在前两个词」既能认出 `MainThread` 的服务进程，又能排除 tmux/shell 等启动器。
- 自检：`python3 scripts/dsh-superagent status --profile superagent` → `pids` 只剩服务进程、`exit=0`。
- 上游 `deepseek-ai/dsh-superagent-prototype` 关闭了 issue 与 PR（`has_issues:false`、`has_pull_requests:false`），改动只能先落在自己的 fork；`git pull` 升级上游时若此文件冲突，保留本改动。

## 7. 本机网络与 GitHub 权限踩坑（2026-11-25 实测，含一次结论反转）

第一版结论「本机网络对 GitHub 写端点系统性 404」**已被推翻**。真实原因有两个，且互相叠加。

**(a) Watt Toolkit「一键加速」= hosts 劫持 + TLS 中间人**

- `/etc/hosts` 把 github.com / api.github.com / raw.githubusercontent.com 等整批指向 127.0.0.1（Steam++ 段落；原 github.com 真实 IP 20.205.243.166 已被注释为 `# Steam++ Backup`）。
- 加速器进程 `/home/ps/WattToolkit/modules/Accelerator/Steam++.Accelerator` 监听 `0.0.0.0:80` 与 `0.0.0.0:443`（无 TUN 网卡，系统代理 mode=none）。
- 它自签根证书 `CN = SteamTools Certificate, OU = Technical Department, O = BeyondDimension, C = CN`（CA:TRUE, pathlen:1），落地 `/usr/local/share/ca-certificates/steamtools.crt`。
- 点「安装证书」**之前**：curl / git / gh 全部报 `x509: certificate signed by unknown authority`、`SSL certificate problem: unable to get local issuer certificate`。
- 点「安装证书」**之后**：已同步 `/etc/ssl/certs/steamtools.pem` 与 `/etc/ssl/certs/a4cfaa66.0`（ca-certificates.crt 证书数 121→122），git/gh 恢复正常（`git ls-remote` OK、`gh api rate_limit` = 5000、`gh-agent api user` = lhbtata-superagent）。
- **curl 仍失败不是因为缺 CA**：curl 8.12.1 默认 `CAfile = /home/ps/.fa-certs/ca-bundle-with-local.pem`（自定义 bundle，不含 steamtools 根证书）。绕过办法：`curl --cacert /usr/local/share/ca-certificates/steamtools.crt ...` → HTTP 200。git/gh 走系统 CA 链，不受影响。

**(b) 写端点 404/403 的真实根因 = OAuth token scope 不足**

- 两个账号（`lhbtata` / `lhbtata-superagent`）的 token scopes 都只有 `gist/read:org/repo`（`gh auth login` 默认），**没有 `delete_repo`**。
- TLS 修好后做受控实验（响应均为 GitHub 原生）：

  | 端点 | 结果 | 含义 |
  |---|---|---|
  | `DELETE /repos/{owner}/{repo}` | 403 `Must have admin rights to Repository.` | 缺 `delete_repo` scope |
  | `POST /repos/{owner}/{repo}/collaborators` | 404 `Not Found` | token 无权管理该仓库 |
  | `POST /repos/{owner}/{repo}/keys` | 422 Validation Failed | 请求确实到达 GitHub，只差 key 格式 |
  | `GET /repos/{owner}/{repo}/collaborators/{u}/permission` | 200 | 读端点正常 |

- GitHub 对「token 无权管理」的管理类端点按惯例回 404/403，而不是带说明的 403 → 早期在网络不稳下看到的是裸 404/403 噪声。
- 补 scope：`gh auth refresh -h github.com -s delete_repo`（浏览器设备码授权）。协作者管理类端点即便补了 scope 仍可能 404，那就走网页端。
- **2026-11-26 更新**：GitHub 访问恢复后，`PUT /repos/lhbtata/superagent-sandbox/collaborators/lhbtata-superagent -f permission=push` 已返回 **201**，邀请可由 agent 账号接受（§11.2）。所以「协作者端点一律 404」不是常态，而是当时的 token/网络状态问题。

**(c) `github.com:443` 间歇性超时（仍存在）**

- git clone / fetch 可能需要重试；worker 的 prepare 首次失败时系统会自动标记 failed 并重派，通常重试即成功（实测第一次 fetch 报 `Failed to connect to github.com port 443 after 135050 ms`，第二次成功）。

## 8. 首次试跑验证记录

1. 操作者在靶场仓库发**新评论**（不是编辑 Issue 正文）`@lhbtata-superagent 请把 README 第二行末尾补上句号` → Issue #1。
2. agent 账号收到 mention 通知 → Source 轮询捕获 → 决策 `accept`（explicitRouted）→ 创建 Ticket。
3. prepare 首次 git fetch 撞网络超时 → 系统自动重派 worker，第二次成功。
4. 产出 PR #2（分支 `agent/readme-add-period-3054365f8671`），commit author/committer 均为 `lhbtata-superagent`。
5. agent 在 Issue 下回评：已提交 PR，本环境无合并工具，需人工审阅合并。
6. Ticket 停在 `stage=person / action=review`，等人工合并。
7. 人工合并 PR #2（merged_at 2026-11-25T08:30:39Z，merge commit `fcbe0a8`）后，superagent 自己把工单收尾：`ended {by: "executor", outcome: "merged"}`，关联线程 `github:2` 记 `closed{outcome: merged}` —— 闭环由系统自动确认，无需手工关单。
8. 合并瞬间 worker 会话收尾抛 AggregateError → `health.worker=error`（见 §2 的处理办法：restart）。
9. **第二次试跑（重启后，可重复性验证）**：Issue #3「README 第二行『靶场』改为『沙箱』」→ Ticket `4f67c070` → PR #4，分支 `agent/readme-sandbox-wording-4f67c0700b90`，基线是已合并的 `fcbe0a8`，diff 仅一行（`-…靶场…` / `+…沙箱…`），commit 署名 `lhbtata-superagent <360978419+lhbtata-superagent@users.noreply.github.com>`。说明「一个仓库、持续接需求」可重复工作。

10. 人工合并 PR #4（merged_at 2026-11-25T08:47:12Z）→ 工单同样自动收尾（`ended{outcome: merged}`），工单列表随即为空；合并瞬间又出现一次同样的 AggregateError 残留（08:47:25Z），`restart` 后 `status` 回到 exit=0、health 十项全 ready。两次合并的表现一致：残留错误只影响面板与退出码，不影响已合并的结果。
11. **脚本修复的实效**：`scripts/dsh-superagent` 的进程识别修复（§6）落地后，`status` 只报服务进程（`pids` 1 个）、`exit=0`，`restart` 能可靠停掉旧进程并起新进程（本次新 pid `3872932`）——修复前 `stop`/`restart` 会判「服务没在跑」，上面第 8、10 条的残留错误就清不掉。

12. **飞书通道验收（2026-11-25 17:33）**：在「dsh-agent组1」群里发 `@Super-agent 介绍一下自己`（当时应用还叫「刘海宾的飞书 CLI」，2026-11-26 改名）→ bot 在**会话线程**内回帖成功（`outbox` 记录 `status: "sent"`，线程 `omt_186323b398ce5ca7` 内用户 17:33 + bot 17:38 两条）。走的是直答路径：不建工单（决策 outcome=ignore、reason code=`said`），符合「不涉及仓库改动就只在会话里回答」的策略。库里链路完整：trigger 3 条（1 条入群系统消息 + 2 条 mention）→ decision 4 条（先 `not_a_member`×2，写 allowed 后 requeue → `said`×2，strength inferred→explicit）→ thread 6 个（github:1-4 + feishu 三条）。
13. **诊断期临时仓库已全部删除**：`lhbtata/sa-collab-probe`、`lhbtata-superagent/sa-collab-test`、`lhbtata/sa-deltest-1125` 经 API 返回 404（确认已删），操作者与 agent 账号下均无残留。
14. **仓库归属切换后的第三次试跑（2026-11-26）**：仓库改为操作者名下 `lhbtata/superagent-sandbox`（agent 作 collaborator，push 无 admin）→ Issue #2「试跑3：README 第二行末尾补句号」→ Ticket `99af264927220e1a1513aea79ff80c0b` → **PR #3**（分支 `agent/readme-add-period-new-99af2649…`），diff 恰好一行补句号，commit 署名 `lhbtata-superagent <360978419+lhbtata-superagent@users.noreply.github.com>`；PR 于 2026-11-26T07:48:26Z 合并（merge commit `b791e85`），工单随即自动收尾 `ended{outcome: merged}`。⚠️ 注意：**write 权限就能合并 PR**，agent 其实能自合 —— 详见 §11.6 的更正与分支保护建议。切换过程中的 404 故障与处理见 §11.3。

## 9. 升级流程

```sh
cd /home/ps/src/dsh-superagent-prototype
cp /home/ps/.dsh/state/superagent/orchestrator.sqlite /path/to/backup/   # 升级前备份状态
git pull        # scripts/dsh-superagent 若冲突：保留本地补丁（§6）
pnpm install && pnpm build
python3 scripts/dsh-superagent restart --profile superagent
```

## 10. 日常操作速查

- 查状态：`python3 scripts/dsh-superagent status --profile superagent`
- 提新需求：操作者在靶场仓库 `lhbtata/superagent-sandbox` **发新评论** `@lhbtata-superagent <请求>`（编辑 Issue 正文不触发）。
- 看进度：面板 `http://127.0.0.1:3082`（Overview / Tickets），或在本机调管理 API（token 按 §2 的方式从启动日志取到变量里用，不回显）：
  ```sh
  TOK=$(grep -oE 'token=[A-Za-z0-9_-]{20,}' "$(ls -t .artifacts/dsh-superagent-superagent-*.log | head -1)" | head -1 | cut -d= -f2)
  curl -H 'x-orchestrator-request: 1' "http://127.0.0.1:3082/orchestrator/api/overview?token=$TOK"
  unset TOK
  ```
- 合并：worker 默认不自动合并 PR，由操作者审阅后合并；合并后跑一次 `restart` 清 worker 残留错误（§2）。
- 飞书提需求：在「dsh-agent组1」群里 `@Super-agent <请求>`（只响应 @ 提及；应用已于 2026-11-26 改名为「Super-agent」，@ 时选这个名字）。
- 飞书相关自检：
  ```sh
  ~/.local/bin/lark-bot auth status --json     # bot ready 且无 user 登录态
  ~/.local/bin/lark-bot im +chat-members-list --chat-id oc_167db7fc1fc970bcf8716e2616f1a3a6 --member-types user,bot --as bot
  ```
- 诊断期建的 3 个临时仓库（`lhbtata/sa-collab-probe`、`lhbtata-superagent/sa-collab-test`、`lhbtata/sa-deltest-1125`）**已全部删除**（API 返回 404 确认），无需再清理。
- 尚待人工处理：**① PR #3（迁移后验收单）待操作者合并；② 旧仓库 `lhbtata-superagent/superagent-sandbox` 已转 private（见 §11.5），是否彻底删除待拍板（需 `gh auth refresh -s delete_repo` 且设备码必须登录 agent 账号）。** 其余（飞书权限、应用改名、通道验收）已于 2026-11-26 完成。此处的待办仅指**当时的待办清单已清空**，不表示以后没有需要人工决定的事：接收名单仍需按 §5.8 的白名单口径维护（新增需求人时要手动加 open_id；`syncChat` 保持关闭）。

## 11. 仓库归属切换（2026-11-26）

### 11.1 为什么要切

- 官方形态是「**仓库归操作者/组织**，agent 账号作为 collaborator 拿写权限」：`SETUP.md:38-39`（第 2 问指定仓库、第 3 问要求专用账号）、`SETUP.md:67`（operator steps 含「以 agent 账号接受仓库邀请」）、`docs/006-deployment.md:33`。
- 切换前是权宜之计：当时操作者 token 缺管理类 scope，`POST /repos/.../collaborators` 被 GitHub 判 404（§7），只好让 agent 自持仓库。**2026-11-26 GitHub 访问恢复后该端点已可正常调用**（201 + 接受邀请），原始形态可恢复。
- 切换前的代价：agent 自持仓库 → agent 有 admin → 实测它把自己的 PR #2/#4 都自己合了（`merged_by = lhbtata-superagent`），违反「auto-merge 默认 No、由人合并」。

### 11.2 切换步骤

```sh
# 1) 加 collaborator（操作者 token 即可）
gh api -X PUT repos/lhbtata/superagent-sandbox/collaborators/lhbtata-superagent -f permission=push
# 2) 由 agent 账号接受邀请
gh-agent api -X PATCH user/repository_invitations/346440054
# 3) 本地克隆改指向
cd /home/ps/src/superagent-sandbox
git remote set-url origin https://github.com/lhbtata/superagent-sandbox.git
git fetch --no-tags origin && git reset --hard origin/main
# 4) 面板改仓库（source 块在 sources 数组里，见 §5.7）
PUT /orchestrator/api/settings/source:github
{"value":{"enabled":true,"config":{"repository":"lhbtata/superagent-sandbox","cli":"/home/ps/.local/bin/gh-agent",
 "pollSeconds":60,"failuresBeforeError":3,"observeIssues":false,"observePulls":false,"observeComments":false,"observeCi":false}},"revision":2}
# 5) 重启
python3 scripts/dsh-superagent restart --profile superagent
```

### 11.3 切换后的坑：旧仓库的 thread 会 404

- 现象：切仓库后 github 源进入 `error`，报 `3 consecutive failed polls; last: Error: 3 GitHub reads failed: github:2: …404; github:3: …404; github:4: …404`。
- 原因：thread / 游标是**按编号存的、与仓库无关**（`github:2`、`github-cursor:2`、`github-ci:2`）。旧仓库的 Issue #2/#3/#4 仍是 subscribed 线程，轮询时去新仓库读同号 Issue → 新仓库只有 #1 → 404；`deleted(error)` 只认 410，404 不算删除，线程不会自动丢弃。
- 处理（用官方 API，不改数据库）：

  ```sh
  for k in github:1 github:2 github:3 github:4; do
    curl -s -X POST -H 'x-orchestrator-request: 1' \
      "http://127.0.0.1:3082/orchestrator/api/threads/$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$k")/unsubscribe"
  done
  ```

  退订后下一轮即恢复 `ready`（`0 notifications; next poll ≥ 60s`）。同法可清 `github-cursor:*` / `github-ci:*` 残留（留在 DB 里无害，只是同号 Issue 会被当作已读过）。
- **第二层坑（编号撞车，退订解决不了）**：thread key 就是 `github:<编号>`，**完全与仓库无关**。新仓库的 Issue #2 复用了旧仓库 PR #2 的 key `github:2`，而该 key 的 meta 里还留着 `isPr:true` + 旧仓库 URL → 轮询按 PR 走，去新仓库读 `pulls/2` → 404（错误串 `github:2: Error: gh: Not Found (HTTP 404)`）。退订只清订阅、不清 meta，所以会复发。
- 彻底解法：停服务后把旧线程的 stale meta 清空，让它按当前仓库重新识别 `isPr` / `title` / `url`（保留 subscriptions，工单关联不断）：

  ```sh
  python3 scripts/dsh-superagent stop --profile superagent
  python3 - <<'PY'
  import sqlite3, json
  db = sqlite3.connect('/home/ps/.dsh/state/superagent/orchestrator.sqlite')
  for r in db.execute("select key,value from thread where key like 'github%'").fetchall():
      v = json.loads(r['value'])
      if v.get('meta'):
          v['meta'] = {}
          db.execute("update thread set value=? where key=?", (json.dumps(v, ensure_ascii=False), r['key']))
  db.commit()
  PY
  python3 scripts/dsh-superagent start --profile superagent
  ```

  本机实测：清完 meta 并重启后，health 十项全 `ready`、`errors: {}`、github 源恢复 `ready`。**换仓库后如果又出现莫名其妙的 404 轮询失败，先想到这条。**
- 顺带说明：`github-cursor:*` / `github-ci:*` 这类 KV 游标也是按编号存的，留在库里无害（同号 Issue 会被当作「已读过」而不重复处理），要彻底重置可一并删掉。

### 11.4 迁移后验收（2026-11-26）

- 操作者在 `lhbtata/superagent-sandbox` 发 Issue #2「试跑3：README 第二行末尾补句号」，正文 @`lhbtata-superagent` → 约 60s 内成单（Ticket `99af264927220e1a1513aea79ff80c0b`，strength=explicit）。
- agent 提交 **PR #3**（分支 `agent/readme-add-period-new-99af2649…`），diff 恰好一行补句号；commit author/committer 均为 `lhbtata-superagent <360978419+lhbtata-superagent@users.noreply.github.com>`。
- collaborator 权限核对：`lhbtata-superagent` = push ✅ / admin ❌。
- **PR #3 于 2026-11-26T07:48:26Z 被合并**（merge commit `b791e85`），README 第二行变为「Super-agent 研究原型靶场仓库（agent 专用）。」；superagent 随即自动收尾：`ended {by:"executor", outcome:"merged"}`，关联线程 `github:3` 记 `closed{outcome: merged}`。合并后又按 §2 跑了一次 `restart` 清 worker 残留，health 12 项全 ready、`errors: {}`。

### 11.6 重要更正：**write 权限就能合并 PR**

- 本文档早期写过「agent 没有 admin，所以不能自己合并 PR」——**这个说法是错的**，实测已推翻：PR #3 的 `merged_by` 是 **`lhbtata-superagent`**（timeline 的 `merged`/`closed` 事件 actor 同为它，merge commit 的 author 名也是它）。GitHub 上**只要对仓库有 write（push）权限就能点合并**，admin 不是合并的前提；「无 admin 不可合并」只在开了分支保护/强制评审时才成立。
- 含义：现在 agent 账号有 push 权限，**它自己提的 PR 自己也能合**。要真正落实「人合并」（官方哲学里 auto-merge 默认 No），得靠仓库侧的保护规则，而不是靠权限等级。
- 建议（未执行，需在 GitHub 网页 Settings → Branches 配）：给 `main` 加一条 **branch protection rule** —— 要求至少 1 个 approval、禁止 direct push、禁止 force push，并**取消 agent 账号的直接 push 许可**（GitHub 无法直接禁止某个协作者 push，只能靠 required reviews + 阻止 bypass；agent 自己的 PR 因「不能批准自己的 PR」规则而无法满足 approval 条件，于是合不了）。
- 顺带结论：**「人合并」在配置层面不可靠时，最强约束是让 agent 账号只有 push、并且给 main 开分支保护**。

### 11.7 旧仓库退役：先转 private，再谈删除（2026-11-26）

旧仓库 `lhbtata-superagent/superagent-sandbox`（切换前 agent 自持、public、agent 有 admin）保留为历史归档。**处置原则：先转 private，再决定删不删。**

- 理由：删除要 `gh auth refresh -h github.com -s delete_repo` 走浏览器设备码，**授权期间仓库仍是 public 暴露着**，而且 agent 在那儿有 admin、能自合 PR。转 private 严格更安全且可逆。
- 转 private（用 agent 自己的 token，agent 是 owner）：

  ```sh
  gh-agent api -X PATCH repos/lhbtata-superagent/superagent-sandbox -F private=true
  # → {"full_name":"lhbtata-superagent/superagent-sandbox","private":true,"visibility":"private"}
  ```

  注意：**操作者 `lhbtata` 对该仓库只有 pull**，没有 admin，所以 `gh api -X PATCH …` 会 404（私有化后操作者视角直接 404，属预期）。
- 转 private 后顺手把遗留 Issue #1、#3 关掉（`gh-agent api -X PATCH repos/…/issues/<n> -f state=closed -f body='迁移收尾：…'`），旧仓库现在 4 个 Issue/PR 全 closed。
- 归档内容核对：README.md（79 字节）+ PR #2/#4（均 merged）。有价值的内容都已并入新仓库 `lhbtata/superagent-sandbox`。
- **删除步骤**：给 agent 账号补 scope 后再删 ——

  ```sh
  gh-agent auth refresh -h github.com -s delete_repo     # 设备码：浏览器须登录 lhbtata-superagent
  gh-agent api -X DELETE repos/lhbtata-superagent/superagent-sandbox
  ```

  未补 scope 时 DELETE 会返回 GitHub 原生 403 `Must have admin rights to Repository.`（本机 2026-11-26 实测）。设备码授权时若登错账号会报 `error refreshing credentials for lhbtata, received credentials for lhbtata-superagent, did you use the correct account in the browser?` —— 上次就是这样失败的。


