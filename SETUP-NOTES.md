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
    - **处理：`python3 scripts/dsh-superagent restart --profile superagent`**（重启后 exit=0、health 十项全 ready；工单与历史留在 `orchestrator.sqlite` 里，不会丢）。仓库里的进程识别修复（见 §5）是这条处置能落地的前提——修复之前 `stop`/`restart` 找不到服务进程，残留错误就一直挂着。

## 3. 账号模型（路线 A）

- 操作者账号：`lhbtata`（本机主账号，提需求的人）。
- agent 账号：`lhbtata-superagent`（agent 身份；PR 提交以该账号 author/committer 署名）。
- 仓库归属：靶场仓库在 **agent 账号自己名下**（公开）。
  - 原因：操作者账号的 OAuth token 缺少管理类 scope，`POST /repos/.../collaborators` 等端点被 GitHub 判 404（§6）；agent 自持仓库则天然有 push 权限，完全绕开。
  - 若日后要恢复「仓库在操作者名下 + 私有 + 协作者授权」的官方原始模型，需在浏览器网页端添加协作者（本机 API 不可用）。
- `gh-agent` 与操作者的 `gh` 凭据目录完全独立（`~/.config/gh-agent` 与 `~/.config/gh`）。
- worker 的 git 凭据走 stateDir 下自动生成的 `worker-gitconfig`（credential helper 指向 `gh-agent`，SSH 强制转 HTTPS），与操作者本机 git 配置隔离。
- 换 agent 账号时只需：`GH_CONFIG_DIR=~/.config/gh-agent gh auth login`，然后面板 Sources 重存一次触发 setup 重校验。

## 4. 模型与运行配置

- LLM（写在 `~/.dsh/profiles/superagent/cordis.patch.yml`，从 web profile 抄来）：
  - `minimax-cn`（`apiKeyEnv=MINIMAX_CN_API_KEY`），默认模型 `MiniMax-M3.1-Flash`；
  - `vllm-local`（`baseURL=http://192.168.0.102:18000/v1`，模型 id `/models/awq`）；
  - `agent-default-model = minimax-cn / MiniMax-M3.1-Flash`。
  - 面板里 eval.model / executor.model 均为 null → 回落到 agent-default-model。
- GitHub Source：repository `lhbtata-superagent/superagent-sandbox`，cli `/home/ps/.local/bin/gh-agent`，pollSeconds 60，observe* 全关（仅 @ 提及触发）。
- Policy：allowed = `lhbtata`（只有操作者能发起）；rules 为默认 copy / visual 两条。
- Executor：maxWorkers 3，工作目录 `/home/ps/.dsh/state/superagent/work`，prepare =
  `git -C /home/ps/src/superagent-sandbox fetch --no-tags <repo>.git <pr-head>:refs/dsh-superagent/<ticket> && git worktree add -b agent/<name> <dir> ...`
  blockedCommands 空。
- eval mode = `observe`（默认；显式请求照常执行，inferred 候选只记录「would accept」）。
- 飞书：未接入（Source 禁用；lark-cli 已装但无 bot 身份）。

## 5. 本地补丁（升级时必须保留）

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

## 6. 本机网络与 GitHub 权限踩坑（2026-11-25 实测，含一次结论反转）

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

**(c) `github.com:443` 间歇性超时（仍存在）**

- git clone / fetch 可能需要重试；worker 的 prepare 首次失败时系统会自动标记 failed 并重派，通常重试即成功（实测第一次 fetch 报 `Failed to connect to github.com port 443 after 135050 ms`，第二次成功）。

## 7. 首次试跑验证记录

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
11. **脚本修复的实效**：`scripts/dsh-superagent` 的进程识别修复（§5）落地后，`status` 只报服务进程（`pids` 1 个）、`exit=0`，`restart` 能可靠停掉旧进程并起新进程（本次新 pid `3872932`）——修复前 `stop`/`restart` 会判「服务没在跑」，上面第 8、10 条的残留错误就清不掉。

## 8. 升级流程

```sh
cd /home/ps/src/dsh-superagent-prototype
cp /home/ps/.dsh/state/superagent/orchestrator.sqlite /path/to/backup/   # 升级前备份状态
git pull        # scripts/dsh-superagent 若冲突：保留本地补丁（§5）
pnpm install && pnpm build
python3 scripts/dsh-superagent restart --profile superagent
```

## 9. 日常操作速查

- 查状态：`python3 scripts/dsh-superagent status --profile superagent`
- 提新需求：操作者在靶场仓库**发新评论** `@lhbtata-superagent <请求>`（编辑 Issue 正文不触发）。
- 看进度：面板 `http://127.0.0.1:3082`（Overview / Tickets），或在本机调管理 API（token 按 §2 的方式从启动日志取到变量里用，不回显）：
  ```sh
  TOK=$(grep -oE 'token=[A-Za-z0-9_-]{20,}' "$(ls -t .artifacts/dsh-superagent-superagent-*.log | head -1)" | head -1 | cut -d= -f2)
  curl -H 'x-orchestrator-request: 1' "http://127.0.0.1:3082/orchestrator/api/overview?token=$TOK"
  unset TOK
  ```
- 合并：worker 默认不自动合并 PR，由操作者审阅后合并。
- 待办清理：诊断期建的 3 个临时仓库尚未删除 —— `lhbtata/sa-collab-probe`、`lhbtata-superagent/sa-collab-test`、`lhbtata/sa-deltest-1125`。API 删除需 `delete_repo` scope（`gh auth refresh -h github.com -s delete_repo`），否则用网页端 Settings → Delete。
