/** Codeup change request binding, lifecycle observation, and terminal IM notification helpers. */
import { key, liveTicket, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { SOURCE, type CodeupChangeRequest } from './codeup-trigger.ts'

export { CodeupChangeRequestSchema, type CodeupChangeRequest } from './codeup-trigger.ts'

/** The page of a change request, built from the repository the deployment works in. */
export const codeupPage = (repository: string, localId: string | number): string =>
  `https://codeup.aliyun.com/${repository}/mergeRequests/${localId}`

/** The number of a change request, read from the thread key that follows it. */
const changeRequestNumber = (thread: string): string | undefined =>
  thread.startsWith(`${SOURCE}:`) ? thread.slice(SOURCE.length + 1) : undefined

/** The change requests a ticket follows, optionally only the ones that are still open. */
export const changeRequestsOf = (ticket: Pick<Ticket, 'follows'>, open = false): string[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => changeRequestNumber(item.thread) ?? [])

/** The change request a ticket works on, the open one first. */
export const changeRequestOf = (ticket: Pick<Ticket, 'follows'>): string | undefined =>
  changeRequestsOf(ticket, true).at(-1) ?? changeRequestsOf(ticket).at(-1)

/**
 * True when the change request is the agent's own work on the configured repository: its author is the account the
 * agent acts as, and it belongs to the repository the deployment watches.
 */
export const agentChangeRequest = (
  request: Pick<CodeupChangeRequest, 'author' | 'projectId'>,
  deployment: Pick<Deployment, 'account' | 'repository' | 'codeup'>,
): boolean => {
  const author = request.author?.username ?? request.author?.name ?? ''
  if (!author || !sameName(author, deployment.account.login)) return false
  const repositoryId = deployment.codeup?.repositoryId
  const projectId = request.projectId
  if (!repositoryId || projectId === undefined || projectId === null) return true
  return String(projectId) === String(repositoryId)
}

/** True when the branch of a change request is the branch the ticket works on. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name

/** Binds a change request to a ticket. */
const bind = (ctx: SourceContext, ticketId: string, request: CodeupChangeRequest, own: boolean): void => {
  const localId = String(request.localId)
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: localId }, own)
    ctx.threads.patch(`${SOURCE}:${localId}`, {
      localId,
      kind: 'changeRequest',
      url: request.detailUrl,
      title: request.title,
      author: request.author?.username ?? request.author?.name,
    })
  })
}

/**
 * Claims a change request for a ticket. The change request either is the one the ticket was opened for, or the agent
 * opened it on the branch the ticket works on. Returns the reason when the change request cannot be claimed.
 */
export function claimChangeRequest(ctx: SourceContext, ticketId: string, request: CodeupChangeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its change request was closed'
  const localId = String(request.localId)
  const origin = ctx.triggers.get(ticket.origin.triggerId)
  const started = origin?.source === SOURCE && String(origin.meta.localId ?? '') === localId
  const opened = agentChangeRequest(request, ctx.deployment) && ticketBranch(ticket, request.sourceBranch ?? '')
  if (!started && !opened) {
    const login = ctx.deployment.account.login
    return `Change request does not belong to this ticket: use the change request the ticket was opened for, or a change request by ${login} on a branch whose last path segment is DSH_SUPERAGENT_NAME`
  }
  const owner = ctx.tickets.open().find(item => changeRequestsOf(item, true).includes(localId))
  if (owner && owner.id !== ticketId) return 'Change request already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${localId}`)
  if (request.state !== 'closed' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, request, opened)
  return undefined
}

/** Closes the change request of every ticket that follows it. */
export function closeChangeRequest(ctx: SourceContext, request: CodeupChangeRequest): void {
  const localId = String(request.localId)
  if (!ctx.tickets.open().some(ticket => changeRequestsOf(ticket, true).includes(localId))) return
  const at = request.mergedAt ?? request.closedAt ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: localId }, request.merged ? 'merged' : 'closed', at)
}

/**
 * Watches a change request: it closes the ticket when the change request ends, and binds it to the one ticket that
 * works on its branch when it is still open.
 */
export async function observeChangeRequest(ctx: SourceContext, request: CodeupChangeRequest): Promise<boolean> {
  const localId = String(request.localId)
  const ended = request.state === 'closed' || request.state === 'merged' || !!request.merged || !!request.mergedAt
  if (ended) {
    closeChangeRequest(ctx, request)
    return true
  }
  const branch = request.sourceBranch ?? ''
  if (!branch) return false
  const candidates = ctx.tickets.open().filter(ticket => ticketBranch(ticket, branch))
  if (candidates.length !== 1) return false
  const ticket = candidates[0]
  if (!ticket) return false
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${localId}`)
  if (!follow || follow.closed) bind(ctx, ticket.id, request, true)
  return false
}

/**
 * The notices the other channels of a ticket receive when its change request ends, so the people who wait in IM learn
 * about it without watching the repository.
 */
export function changeRequestEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && changeRequestNumber(item.thread) !== undefined)
  const latest = (items: typeof follows): typeof follows[number] | undefined =>
    items.sort((left, right) => (right.closed?.at ?? '').localeCompare(left.closed?.at ?? ''))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const localId = changeRequestNumber(follow.thread)!
  const url = repository ? codeupPage(repository, localId) : `mergeRequests/${localId}`
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged'
      ? `变更请求 #${localId}（${url}）已合并。`
      : `变更请求 #${localId}（${url}）已关闭，未合并。`
    : outcome === 'merged'
      ? `Change request #${localId} (${url}) has merged.`
      : `Change request #${localId} (${url}) was closed without merging.`
  return ticket.channels
    .filter(channel => channel.source !== SOURCE)
    .map(channel => ({
      id: key('codeup-terminal', localId, channel.source, JSON.stringify(channel.address), outcome),
      channel,
      text,
      kind: 'notice',
      ticketId: ticket.id,
    }))
}
