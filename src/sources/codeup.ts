/** Codeup source kind definition, change request and comment polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { family } from '../kv.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import type { Localized, SourceKind } from './kind.ts'
import { changeRequestTrigger, commentTrigger, isAgentAccount, SOURCE, type CodeupChangeRequest } from './codeup-trigger.ts'
import { codeupThreadContext, codeupIdentifiers, readChangeRequest, readChangeRequests, readComments } from './codeup-read.ts'
import { changeRequestsOf, observeChangeRequest } from './codeup-pull.ts'
import { codeupLink, codeupStatus, sendCodeup } from './codeup-channel.ts'

/** The settings of the Codeup Source. */
export const CodeupConfigSchema = z.object({
  repository: z.string().trim().default(''),
  cli: z.string().trim().default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeChangeRequests: z.boolean().default(true),
  observeComments: z.boolean().default(false),
}).strict()
export type CodeupConfig = z.infer<typeof CodeupConfigSchema>

/**
 * The accounts the Policy admits, and the bot accounts it treats as candidates. A Codeup account is named by its
 * display name, which is often an email address, or by its platform login, which carries the `aliyun:` prefix; both
 * forms are accepted.
 */
const CODEUP_ACCOUNT = /^[A-Za-z0-9._:@-]{1,120}$/
const CodeupPolicySchema = z.object({
  allowed: z.array(z.object({ id: z.string().regex(CODEUP_ACCOUNT) }).strict()).default([]),
  bots: z.array(z.object({ id: z.string().regex(CODEUP_ACCOUNT) }).strict()).optional(),
}).strict()

/** The rows of the Source, and the setting that opens each of them. */
const OBSERVED = { changeRequests: 'observeChangeRequests', comments: 'observeComments' } as const

/** The cursor of the change request stream of the repository, and the cursor of the comments of every change request. */
const requestCursor = family<string, []>('codeup-cursor-requests:')
const commentCursor = family<string, [string]>('codeup-cursor-comments:')

/** The row a Trigger belongs to. */
function scopeOf(meta: Record<string, unknown>): keyof typeof OBSERVED | undefined {
  if (meta.kind === 'changeRequest') return 'changeRequests'
  if (meta.kind === 'comment') return 'comments'
  return undefined
}

/** The Codeup Source kind: change requests and their comments of one repository of one organization. */
export const codeupKind: SourceKind<CodeupConfig> = {
  kind: SOURCE,
  title: { zh: 'Codeup', en: 'Codeup' },
  description: {
    zh: '智能体的 Codeup 账号；接收仓库里的变更请求、变更请求上的评论，以及变更请求的合并与关闭。',
    en: "The agent's Codeup accounts; receives the change requests of the repository, the comments on them, and their merge or close.",
  },
  schema: CodeupConfigSchema,
  fields: [
    {
      key: 'repository',
      type: 'text',
      label: { zh: '仓库', en: 'Repository' },
      hint: { zh: '写作 organization/repository。这个来源接收这个仓库的变更请求和评论。', en: 'Written organization/repository. This Source receives the change requests of this repository and the comments on them.' },
    },
    {
      key: 'cli',
      type: 'text',
      label: { zh: 'Codeup 命令行', en: 'Codeup CLI' },
      hint: { zh: '读取和写入 Codeup 用的命令行；需要已经登录。', en: 'The command line that reads and writes Codeup; it has to be logged in.' },
    },
    {
      key: 'pollSeconds',
      type: 'number',
      min: 60,
      max: 3600,
      label: { zh: '轮询间隔（秒）', en: 'Poll interval (seconds)' },
    },
    {
      key: 'failuresBeforeError',
      type: 'number',
      min: 1,
      max: 20,
      label: { zh: '连续失败多少次后报错', en: 'Failures before an error' },
    },
    {
      key: 'observeChangeRequests',
      type: 'switch',
      label: { zh: '接收变更请求', en: 'Receive change requests' },
      hint: { zh: '打开后，新建的变更请求也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New change requests are received too, and the Policy’s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' },
    },
    {
      key: 'observeComments',
      type: 'switch',
      label: { zh: '接收评论', en: 'Receive comments' },
      hint: { zh: '打开后，变更请求上新建的评论也会收到。云效的 OpenAPI 目前没有列出评论的读取接口，所以默认关闭；变更请求上的评论条数仍会读到。', en: 'New comments on the change requests are received too. Codeup’s OpenAPI lists no endpoint that reads the comments of a change request, so this is off by default; the number of comments is read all the same.' },
    },
  ],
  health: ['codeup'],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  channel: { send: sendCodeup, link: codeupLink },
  threadContext: codeupThreadContext,
  find: query => {
    const text = query.trim()
    const number = (/^#?(\d+)$/.exec(text)
      ?? /codeup\.aliyun\.com\/[^/]+\/[^/]+\/change\/(\d+)/.exec(text)
      ?? /\/change\/(\d+)/.exec(text))?.[1]
    return { threads: number ? [`${SOURCE}:${number}`] : [], terms: [] }
  },
  policy: {
    schema: CodeupPolicySchema,
    fields: [
      {
        key: 'allowed',
        type: 'rows',
        label: { zh: '允许的账号', en: 'Allowed accounts' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9._:@-]+' }],
      },
      {
        key: 'bots',
        type: 'rows',
        label: { zh: '机器人账号', en: 'Bot accounts' },
        columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9._:@-]+' }],
      },
    ],
    explicit: {
      zh: '只有明确 @ 智能体的请求会成为候选；名单里的账号和机器人的评论会成为推断的候选。',
      en: 'Only requests that address the agent explicitly become candidates; comments of listed accounts and bots become inferred candidates.',
    },
    rows: stored => {
      const config = CodeupPolicySchema.partial().safeParse(stored ?? {})
      const parsed = config.success ? config.data : { allowed: [], bots: [] }
      const cells = { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: false }
      return [
        {
          id: 'allowed',
          label: { zh: '允许的账号', en: 'Allowed accounts' },
          note: { zh: '这些账号的评论会被接收', en: 'Comments of these accounts are received' },
          cells,
        },
        {
          id: 'bots',
          label: { zh: '机器人账号', en: 'Bot accounts' },
          note: { zh: '这些机器人的评论会成为推断的候选', en: 'Comments of these bots become inferred candidates' },
          cells,
        },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_CODEUP_REPOSITORY', description: { zh: '当前仓库', en: 'The repository in work' } },
      { key: 'DSH_SUPERAGENT_CODEUP_ACCOUNT', description: { zh: '当前账号', en: 'The account in work' } },
      { key: 'DSH_SUPERAGENT_CODEUP_COMMIT_EMAIL', description: { zh: '提交用的邮箱', en: 'The email to commit with' } },
      { key: 'DSH_SUPERAGENT_CODEUP_NUMBER', description: { zh: '当前变更请求的编号', en: 'The number of the change request in work' } },
      { key: 'DSH_SUPERAGENT_CODEUP_MR_HEAD', description: { zh: '当前变更请求的源分支', en: 'The source branch of the change request in work' } },
    ],
    values: ({ deployment, trigger }) => ({
      DSH_SUPERAGENT_CODEUP_REPOSITORY: deployment.repository,
      DSH_SUPERAGENT_CODEUP_ACCOUNT: deployment.account.login,
      DSH_SUPERAGENT_CODEUP_COMMIT_EMAIL: deployment.account.noreply,
      DSH_SUPERAGENT_CODEUP_NUMBER: trigger?.meta.localId === undefined ? '' : String(trigger.meta.localId),
      DSH_SUPERAGENT_CODEUP_MR_HEAD: trigger?.meta.sourceBranch === undefined ? '' : String(trigger.meta.sourceBranch),
    }),
  },
  facts: (deployment): Record<string, Localized | string> =>
    deployment ? { cli: { zh: `当前账号 @${deployment.account.login}`, en: `Current account @${deployment.account.login}` } } : {},
}

/** The health of a Source whose polls keep failing. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}

/** One polling round: the change requests of the repository, the change requests the tickets follow, then the comments of the subscribed threads. */
interface Round {
  started: string
  signal?: AbortSignal | undefined
  count: number
  failures: string[]
  dropped: string[]
}

/** A round that reads nothing yet. */
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, count: 0, failures: [], dropped: [] })

/** True when the Source must stop reading. */
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)

/** Names the thread of a change request after it. */
function nameThread(ctx: SourceContext, request: CodeupChangeRequest): void {
  const localId = String(request.localId)
  const title = request.title ?? ''
  ctx.threads.patch(`${SOURCE}:${localId}`, { localId, title, url: request.detailUrl })
  ctx.threads.describe(`${SOURCE}:${localId}`, {
    label: `#${localId} ${title}`.trim(),
    facts: { number: { value: `#${localId}` } },
  })
}

/**
 * Reads the change requests of the repository and the change requests the open tickets follow. Each read fails on its
 * own, so a failure of the comment endpoint never keeps the change requests from being read.
 */
async function pollChangeRequests(ctx: SourceContext, round: Round, config: CodeupConfig): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const { repositoryId } = codeupIdentifiers(commands)
  const since = ctx.state.get(requestCursor()) ?? round.started
  let read = false
  if (config.observeChangeRequests) {
    const query = [
      `projectIds=${repositoryId}`,
      'state=opened',
      'orderBy=created_at',
      'sort=asc',
      // The CLI percent-encodes every query value itself; a pre-encoded value would be encoded twice.
      `createdAfter=${since}`,
    ]
    try {
      const requests = await readChangeRequests(commands, query)
      read = true
      const login = ctx.deployment.account.login
      for (const request of requests) {
        if (stopped(ctx, round)) return
        const created = Date.parse(request.createdAt ?? '')
        if (Number.isFinite(created) && created < Date.parse(since)) continue
        // The change requests of the agent itself are its own work; they are not news to it.
        if (isAgentAccount(request.author, login)) continue
        const trigger = changeRequestTrigger(request, login)
        if (trigger.text) await ctx.receive(trigger)
        round.count += 1
        nameThread(ctx, request)
      }
    } catch (error) {
      round.failures.push(`change requests: ${String(error)}`)
    }
  }
  const followed = [...new Set(ctx.tickets.open().flatMap(ticket => changeRequestsOf(ticket, true)))]
  for (const localId of followed) {
    if (stopped(ctx, round)) return
    try {
      const request = await readChangeRequest(commands, localId)
      await observeChangeRequest(ctx, request)
      nameThread(ctx, request)
    } catch (error) {
      const status = codeupStatus(error)
      if (status === 404 || status === 410) {
        round.dropped.push(localId)
        continue
      }
      round.failures.push(`#${localId}: ${String(error)}`)
    }
  }
  // The cursor only moves when the list was read, so a failed read does not swallow change requests.
  if (read) ctx.state.set(requestCursor(), cursorAt(round.started))
}

/** Reads the comments of the subscribed change requests. */
async function pollThreads(ctx: SourceContext, round: Round, config: CodeupConfig): Promise<void> {
  if (!config.observeComments) return
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    const localId = thread.ref.id
    try {
      const commands = ctx.commands.withSignal(round.signal)
      const checkpoint = commentCursor(localId)
      const since = ctx.state.get(checkpoint) ?? thread.createdAt
      const comments = await readComments(commands, localId)
      const login = ctx.deployment.account.login
      for (const comment of comments) {
        if (stopped(ctx, round)) throw new Error('The Codeup Source stopped during the poll')
        const at = Date.parse(comment.lastEditTime ?? comment.commentTime ?? '')
        if (Number.isFinite(at) && at < Date.parse(since)) continue
        if (isAgentAccount(comment.author, login)) continue
        if (comment.deleted) continue
        const trigger = commentTrigger(comment, { localId }, login)
        if (trigger.text) await ctx.receive(trigger)
        round.count += 1
      }
      ctx.state.set(checkpoint, cursorAt(round.started))
    } catch (error) {
      const status = codeupStatus(error)
      if (status === 404 || status === 410) {
        round.dropped.push(thread.ref.id)
        return
      }
      round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.dropped.includes(thread.ref.id))
}

/** Polls once and reports how the Source is doing. */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const config = ctx.config<CodeupConfig>(SOURCE)
  if (!config) return 60
  await pollChangeRequests(ctx, round, config)
  await pollThreads(ctx, round, config)
  if (round.failures.length) throw new Error(`${round.failures.length} Codeup reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const dropped = round.dropped.length ? `; gone on Codeup: ${round.dropped.join(', ')}` : ''
  const interval = Math.max(60, config.pollSeconds)
  ctx.report('codeup', { state: 'ready', detail: `${round.count} notifications; next poll ≥ ${interval}s${dropped}`, at: round.started })
  return interval
}

/**
 * The polling loop of the Source. It waits for the deployment, stops when the Source is not the code host of the
 * deployment, and reports the health of the Source after every round and after enough failed rounds in a row.
 */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) {
    ctx.report('codeup', health('paused', 'setupPending'))
    return
  }
  if (ctx.deployment.host !== 'codeup') {
    ctx.report('codeup', health('paused', 'sourceOff'))
    return
  }
  // Without a Codeup CLI there is nothing to read yet; the Source waits instead of failing every round.
  if (!ctx.deployment.account.cli) {
    ctx.report('codeup', health('paused', 'setupPending'))
    return
  }
  while (!signal.aborted) {
    const config = ctx.config<CodeupConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('codeup', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('codeup', failed)
    }
    await pause(Math.max(interval, ctx.config<CodeupConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

/** The Cordis plugin entry of the Codeup Source. */
export const name = 'dsh-superagent-codeup'
export const inject = ['orchestrator']

/** Registers the Codeup Source kind and starts its polling loop. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(codeupKind), 'codeup: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, codeupKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report('codeup', { state: 'error', detail: String(error) })
    })
    return async () => {
      controller.abort()
      await running
    }
  })
}
