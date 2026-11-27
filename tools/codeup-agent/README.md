# codeup-agent

阿里云效（Codeup）的极简命令行客户端（CLI shim），供 `dsh-superagent` 的 TypeScript
侧以子进程方式调用。

- 纯 Python 3 标准库实现（`urllib` / `json` / `argparse` / `os` / `sys`），不装任何依赖。
- 面向 GitHub `gh api` 的调用习惯做了形状对齐，但完全独立，不复用 `gh`。
- **只读**：不写任何本地状态文件（无缓存、无凭据落盘、不改写配置文件）。
- 任何日志、错误、异常里都不会出现 token 明文（一律脱敏成 `***`）。

## 文件

| 路径 | 说明 |
| --- | --- |
| `tools/codeup-agent/codeup` | 可执行 CLI（`chmod 755`，`#!/usr/bin/env python3`） |
| `tools/codeup-agent/README.md` | 本说明 |
| `tools/codeup-agent/selftest.py` | 自测脚本（本地 mock HTTP 服务，全部通过退出 0） |

安装到 PATH（可选，仓库内是唯一真源）：

```bash
ln -sf /home/ps/src/dsh-superagent-prototype/tools/codeup-agent/codeup ~/.local/bin/codeup
```

## 命令一览

```
codeup api user
codeup api repos/<owner>/<name>
codeup api <path> [--query K=V]... [--method METHOD] [--field K=V]... [--json '<json>'] [--raw]
codeup auth status
```

只有两个子命令：`api` 与 `auth`。**没有** `--jq`、`--include`、`--paginate`、`--slurp`，
也**没有** `auth git-credential`；用到时按下表自行实现。

### `codeup api user`

返回当前登录用户。stdout 是 JSON 对象，**至少**含 `login`（字符串）与 `id`（字符串或数字）：

```json
{
  "login": "zhangsan",
  "id": "1001",
  "name": "张三"
}
```

底层请求：`GET {base}/oapi/v1/platform/user`，响应原样透传；若接口没给 `login`，
用 `name` / `username` / `nickName` / `displayName` 兜底补齐；若没给 `id`，
用 `userId` / `user_id` 兜底补齐（都拿不到时给空字符串，保证字段恒存在）。

### `codeup api repos/<owner>/<name>`

返回仓库信息与权限。stdout 是 JSON 对象，**至少**含：

```json
{
  "id": "repo-1",
  "full_name": "owner/name",
  "permissions": { "push": true, "pull": true },
  "permissionSource": "api"
}
```

- `full_name` 固定为 `"<owner>/<name>"`。
- `permissions.push` / `permissions.pull` 是布尔值；接口没返回权限信息时默认 `true`，
  并把 `permissionSource` 标为 `"default"`（`"api"` 表示来自接口真实返回）。
- `id` 是仓库 ID 字符串。

底层请求：`GET {base}/oapi/v1/codeup/organizations/{organizationId}/repositories?name={name}`，
取 `name` 匹配项（响应可能直接是数组，也可能包在 `repositories` / `result` / `items` / `data` / `list` 里）。
配置里已有 `repositoryId` 时不再查询，直接用它作为 `id`。

### `codeup api <path> ...`（通用 REST 透传）

- `path` 以 `/oapi/` 或 `/api/` 开头 → 原样使用；否则自动补前缀 `/oapi/v1/codeup/`。
- `--query K=V`：按**第一个** `=` 切分，值原样（做 URL 编码），可重复。
- `--method METHOD`：默认 `GET`，支持 `POST` / `PUT` / `PATCH` / `DELETE`。
- `--field K=V`：进入 JSON body 的字符串字段，可重复；同名时**覆盖** `--json` 里的值。
- `--json '<json>'`：JSON 对象，作为 body 的基础；与 `--field` 合并时 `--field` 优先。
- 无 body 的方法（`GET` / `HEAD` / `DELETE`）不发送 body。
- stdout **原样**输出响应体，不做任何改写或包装。

示例：

```bash
codeup api 'organizations/123/repositories' --query page=1 --query per_page=50
codeup api 'repos/1/branches' --method POST --json '{"name":"main"}' --field protected=true
codeup api /oapi/v1/codeup/custom/path
```

分页参数名由调用方通过 `--query` 决定（云效 REST 常用 `page` / `per_page`，本 CLI 不做特殊处理）；
列表响应的外层包装（`{"items":[...]}` / `{"repositories":[...]}` / 直接数组）在通用透传里**原样保留**，
只有 `api repos/...` 会自己拆开找匹配项。

### `codeup auth status`

stdout：

```json
{ "loggedIn": true, "login": "zhangsan", "domain": "codeup.example.com" }
```

**绝不输出 token 本身。** token 缺失时 stdout 打印 `{"loggedIn": false, "login": "", "domain": ...}`，
stderr 打印错误 JSON，退出码 1。

## 配置

优先级：**环境变量 > 配置文件**。

| 环境变量 | 配置文件字段 | 说明 |
| --- | --- | --- |
| `CODEUP_BASE_URL` | — | 接口基址，优先于 `domain`（测试/私有化部署用） |
| `CODEUP_DOMAIN` | `domain` | 云效域名，基址为 `https://{domain}` |
| `CODEUP_TOKEN` | `token` | 个人访问令牌（形如 `pt-xxxx`） |
| `CODEUP_ORGANIZATION_ID` | `organizationId` | 组织 ID，`api repos/...` 查询用 |
| `CODEUP_REPOSITORY_ID` | `repositoryId` | 仓库 ID，有值时不再查询仓库列表 |
| `CODEUP_CONFIG` | — | 配置文件路径，缺省 `~/.config/codeup-agent/config.json` |
| `CODEUP_TIMEOUT` | — | HTTP 超时秒数，缺省 30 |

补充：`YUNXIAO_PERSONAL_TOKEN` 作为 `CODEUP_TOKEN` 的**兼容别名**（优先级低于 `CODEUP_TOKEN`）。

配置文件示例 `~/.config/codeup-agent/config.json`：

```json
{
  "domain": "codeup.example.com",
  "token": "pt-xxxxxxxxxxxxxxxx",
  "organizationId": "5f8xxxxx",
  "repositoryId": "6a1xxxxx",
  "owner": "my-group",
  "repository": "my-repo"
}
```

缺 token（或缺 domain）时：stderr 输出中文错误，**包含「缺少 token」字样与配置文件路径**，
退出码 1，且不含 token 明文。

## 退出码与错误格式

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 运行 / 认证 / HTTP 错误 |
| 2 | 用法错误（参数不合法、未知子命令等） |

退出码 1 时 stderr 是**一行 JSON**（UTF-8，不转义中文）：

```json
{"error": {"status": 404, "message": "{\"message\":\"repository not found\"}"}}
```

- `status`：HTTP 状态码；网络错误等非 HTTP 失败为 `null`。
- `message`：人类可读的失败原因；HTTP 失败时取响应体原文（超长截断到 2000 字符）。
- 任何 token 明文在写入 stderr 前都会被替换成 `***`。

用法错误（退出码 2）同样走这个 JSON 格式，`message` 以「用法错误：」开头。

## 自测

```bash
python3 /home/ps/src/dsh-superagent-prototype/tools/codeup-agent/selftest.py
```

自测脚本会起一个本地 mock HTTP 服务（`http.server`，随机端口），用 `subprocess` 调用
`codeup` 并断言：

1. `api user` 返回 `login` 与 `id`；
2. `api repos/o/r` 返回 `full_name` 与 `permissions.push = true`；
3. `--method POST --field a=b` 时 mock 收到 POST 方法与 JSON body `{"a":"b"}`；
4. `--query k=v` 时 mock 收到该 query；
5. mock 返回 404 → 退出码 1 且 stderr 是 error JSON；
6. 缺 token → 退出码 1，且输出里没有 token 明文。

全部通过退出码 0；任一失败会打印期望/实际差异并以非 0 退出。
