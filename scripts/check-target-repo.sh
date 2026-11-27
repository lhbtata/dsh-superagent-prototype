#!/usr/bin/env bash
# check-target-repo.sh —— 目标仓库「接入 Super-agent 前」的只读体检。
#
# 用法：
#   bash scripts/check-target-repo.sh [仓库路径] [仓库短名]
#
# 本脚本只读：只做查询，不改仓库、不删文件、不推远端、不改配置。
# 退出码：0 = 全部通过（可能有 WARN），1 = 存在 FAIL。
#
# 检查项分四组：
#   A 仓库健康（工作区、分支、未推送提交、远端类型）
#   B 敏感面（明文凭据、.env 跟踪、历史大 blob）
#   C 工具链（本机构建所需的命令是否齐）
#   D 接入准备（Codeup 连通性、仓库读权限、agent 账号、prepare 可行性）

set -uo pipefail

REPO="${1:-/home/ps/.openclaw/workspace/xuanjiAPP}"
REPO_NAME="${2:-xuanjiAPP}"

PASS=0
WARN=0
FAIL=0
LINES=()

ok()   { PASS=$((PASS+1)); LINES+=("PASS  $1"); }
warn() { WARN=$((WARN+1)); LINES+=("WARN  $1${2:+ — $2}"); }
bad()  { FAIL=$((FAIL+1)); LINES+=("FAIL  $1${2:+ — $2}"); }
info() { LINES+=("INFO  $1"); }
head_() { LINES+=(""); LINES+=("── $1"); }

have() { command -v "$1" >/dev/null 2>&1; }

echo "== 目标仓库体检：$REPO"
echo "== 时间：$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo

if [ ! -d "$REPO/.git" ]; then
  echo "FAIL  不是 git 仓库：$REPO"
  exit 1
fi

cd "$REPO" || exit 1

# ---------------------------------------------------------------- A 仓库健康
head_ "A 仓库健康"

if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  ok "工作区干净（无未提交改动）"
else
  bad "工作区有未提交改动" "$(git status --porcelain | wc -l) 个条目，先提交或 stash"
fi

BRANCH="$(git branch --show-current 2>/dev/null)"
[ -n "$BRANCH" ] && info "当前分支：$BRANCH" || bad "无法读取当前分支（detached HEAD？）"

REMOTE_URL="$(git remote get-url origin 2>/dev/null)"
info "origin：${REMOTE_URL:-（无 origin）}"

case "${REMOTE_URL:-}" in
  *codeup.aliyun.com*)
    ok "远端是阿里云 Codeup（Super-agent 走 codeup source）" ;;
  *github.com*)
    ok "远端是 GitHub（Super-agent 走 github source）" ;;
  "")
    bad "没有 origin remote" ;;
  *)
    warn "远端类型未知" "$REMOTE_URL" ;;
esac

if git rev-parse --verify origin/"$BRANCH" >/dev/null 2>&1; then
  AHEAD="$(git rev-list --count origin/"$BRANCH"..HEAD 2>/dev/null || echo 0)"
  BEHIND="$(git rev-list --count HEAD..origin/"$BRANCH" 2>/dev/null || echo 0)"
  if [ "${AHEAD:-0}" -gt 0 ]; then
    warn "有 ${AHEAD} 个提交未推送到 origin/$BRANCH" "agent 要基于最新代码开工，建议先 push"
  else
    ok "已与 origin/$BRANCH 同步"
  fi
  if [ "${BEHIND:-0}" -gt 0 ]; then
    warn "落后 origin/$BRANCH ${BEHIND} 个提交" "开工前先 git pull"
  fi
  CHANGED="$(git diff --name-only origin/"$BRANCH"..HEAD 2>/dev/null | wc -l)"
  [ "${CHANGED:-0}" -gt 0 ] && info "未推送提交改动文件数：${CHANGED}"
else
  warn "origin 上没有同名分支 $BRANCH" "agent 建 PR/MR 时可能没有基线分支"
fi

# ---------------------------------------------------------------- B 敏感面
head_ "B 敏感面"

# 明文凭据：阿里云 AK/SK 这类固定前缀
SECRET_HITS="$(git grep -nIE '(accessKeySecret|accessKeyId|AKIA[0-9A-Z]{16}|pt-[A-Za-z0-9_-]{12,})' -- \
  ':!*.lock' ':!package-lock.json' ':!*.md' 2>/dev/null | head -20)"
if [ -n "$SECRET_HITS" ]; then
  bad "工作区存在疑似明文凭据" "$(printf '%s' "$SECRET_HITS" | grep -c . ) 处，见下方清单"
  while IFS= read -r line; do [ -n "$line" ] && LINES+=("        ${line:0:150}"); done <<< "$SECRET_HITS"
  LINES+=("        → 迁移/接入前先轮换这些密钥")
else
  ok "工作区未检出常见明文凭据模式"
fi

# 历史里的凭据（只看当前分支历史里首次出现的文件名）
HIST_SECRET="$(git log --all --oneline -S'accessKeySecret' -- '*.java' '*.js' '*.ts' '*.env' 2>/dev/null | head -5)"
if [ -n "$HIST_SECRET" ]; then
  bad "git 历史里出现过密钥字面量" "$(printf '%s' "$HIST_SECRET" | wc -l) 个提交引入，需轮换 + 清理历史"
else
  ok "历史里未检出密钥字面量"
fi

TRACKED_ENV="$(git ls-files | grep -E '(^|/)\.env($|\.)' | head -10)"
if [ -n "$TRACKED_ENV" ]; then
  bad "有 .env 类文件被 git 跟踪" "$(printf '%s' "$TRACKED_ENV" | tr '\n' ' ')"
else
  ok "没有 .env 类文件被跟踪"
fi

# 历史大 blob：Codeup 单文件上限 200MB，GitHub 100MB
BIG_BLOBS="$(git rev-list --objects --all 2>/dev/null \
  | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' 2>/dev/null \
  | awk '$1=="blob" && $3>52428800 {print $3, $4}' | sort -rn | head -10)"
if [ -n "$BIG_BLOBS" ]; then
  warn "历史里有 >50MB 的 blob" "推送到任何远端前建议先瘦身"
  while IFS= read -r line; do [ -n "$line" ] && LINES+=("        $line"); done <<< "$BIG_BLOBS"
else
  ok "历史里没有 >50MB 的 blob"
fi

LOG_FILES="$(git ls-files | grep -cE 'ops/audit/health/.*\.(log|txt)$' || true)"
if [ "${LOG_FILES:-0}" -gt 0 ]; then
  warn "跟踪了 ${LOG_FILES} 个运行日志文件" "agent 每次改动都会带上它们，建议 .gitignore"
fi

# ---------------------------------------------------------------- C 工具链
head_ "C 工具链"

for cmd in git node npm python3 mvn java; do
  if have "$cmd"; then
    ok "$cmd 可用：$(command -v "$cmd")"
  else
    bad "$cmd 缺失" "构建/校验流程会失败"
  fi
done

if have pwsh; then
  ok "pwsh 可用：$(pwsh --version 2>/dev/null | head -1)"
else
  warn "pwsh 缺失" "AGENTS.md 的双源同步脚本跑不了；Linux 下用 python3 tools/check_dual_source.py 代替"
fi

if [ -f package.json ]; then
  if grep -q '"test"' package.json 2>/dev/null; then
    ok "package.json 有 test 脚本"
  else
    warn "package.json 没有 test 脚本" "agent 无法用 npm test 自验"
  fi
  if grep -q '"check:lifecycle"' package.json 2>/dev/null; then
    ok "存在 check:lifecycle 门禁脚本"
  else
    info "没有 check:lifecycle 门禁脚本（AGENTS.md 若提到，说明仓库尚未落地）"
  fi
else
  info "仓库根目录没有 package.json（可能不是前端仓库）"
fi

for f in AGENTS.md CLAUDE.md .cursorrules; do
  [ -f "$f" ] && ok "存在约定文件：$f"
done

# ---------------------------------------------------------------- D 接入准备
head_ "D 接入准备"

if have ssh; then
  CODEUP_HI="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@codeup.aliyun.com 2>&1 | head -2)"
  case "$CODEUP_HI" in
    *"Welcome to Codeup"*) ok "SSH 到 Codeup 可用（BatchMode 无交互）" ;;
    *) warn "SSH 到 Codeup 探测异常" "$(printf '%s' "$CODEUP_HI" | head -1)" ;;
  esac
else
  bad "ssh 不可用" "无法确认 Codeup 连通性"
fi

if [ -n "${CODEUP_TOKEN:-}" ]; then
  ok "环境变量 CODEUP_TOKEN 已设置"
else
  warn "环境变量 CODEUP_TOKEN 未设置" "OpenAPI 调用（列 MR、读评论）需要个人访问令牌 pt-…"
fi

for f in "$HOME/.config/codeup-agent/config.json"; do
  [ -f "$f" ] && ok "存在 Codeup 配置文件：$f" || warn "缺少 $f" "需要 domain / token / organizationId / repositoryId"
done

if git rev-parse --verify origin/"$BRANCH" >/dev/null 2>&1; then
  ok "存在可供 agent 拉取的基线分支 origin/$BRANCH"
else
  bad "没有基线分支" "executor.prepare 无法 fetch"
fi

# prepare 可行性：能否从本地克隆开出 worktree（不真的建，只看能力）
if git worktree list >/dev/null 2>&1; then
  WT_COUNT="$(git worktree list | wc -l)"
  ok "支持 git worktree（当前 ${WT_COUNT} 个 worktree）"
else
  bad "不支持 git worktree" "executor.prepare 的标准流程不可用"
fi

if git config --get user.name >/dev/null 2>&1 && git config --get user.email >/dev/null 2>&1; then
  ok "本机有 git 身份：$(git config user.name) <$(git config user.email)>"
else
  warn "本机没配 git user.name/user.email" "agent 提交时会失败"
fi

# ---------------------------------------------------------------- 汇总
echo
for l in "${LINES[@]}"; do echo "$l"; done
echo
echo "== 结果：PASS ${PASS} / WARN ${WARN} / FAIL ${FAIL}"
if [ "$FAIL" -gt 0 ]; then
  echo "== 结论：存在阻塞项，不建议直接接入 Super-agent。"
  exit 1
fi
if [ "$WARN" -gt 0 ]; then
  echo "== 结论：无阻塞项，但有 WARN 需要人工确认。"
  exit 0
fi
echo "== 结论：全部通过。"
exit 0
