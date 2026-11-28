/** Codeup trigger builders: change requests, comments, the channel address, and mention detection. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

/** The source kind Codeup triggers and threads carry. */
export const SOURCE = 'codeup'

/** A Codeup account, the author of a change request or of a comment. */
export const CodeupUserSchema = z.looseObject({
  avatar: z.string().nullish(),
  email: z.string().nullish(),
  name: z.string().nullish(),
  state: z.string().nullish(),
  userId: z.union([z.string(), z.number()]).nullish(),
  username: z.string().nullish(),
})
export type CodeupUser = z.infer<typeof CodeupUserSchema>

/**
 * A Codeup change request, the merge request of a repository. Every field the Source reads is optional but the one
 * that identifies it, so a change request that arrives with fewer fields still parses.
 *
 * The list and the detail of a change request name the same things differently: the list answers `state` and
 * `createdAt`, the detail answers `status` and `createTime`. The schema folds the detail's names into the list's, and
 * lowercases the state, so that the rest of the Source reads one shape.
 */
export const CodeupChangeRequestSchema = z.looseObject({
  localId: z.union([z.number(), z.string()]),
  title: z.string().nullish(),
  state: z.string().nullish(),
  status: z.string().nullish(),
  detailUrl: z.string().nullish(),
  description: z.string().nullish(),
  createdAt: z.string().nullish(),
  createTime: z.string().nullish(),
  updatedAt: z.string().nullish(),
  updateTime: z.string().nullish(),
  mergedAt: z.string().nullish(),
  closedAt: z.string().nullish(),
  merged: z.boolean().nullish(),
  totalCommentCount: z.number().nullish(),
  unResolvedCommentCount: z.number().nullish(),
  projectId: z.union([z.string(), z.number()]).nullish(),
  sourceBranch: z.string().nullish(),
  targetBranch: z.string().nullish(),
  author: CodeupUserSchema.nullish(),
}).transform(request => ({
  ...request,
  state: (request.state ?? request.status)?.toLowerCase(),
  createdAt: request.createdAt ?? request.createTime,
  updatedAt: request.updatedAt ?? request.updateTime,
}))
export type CodeupChangeRequest = z.infer<typeof CodeupChangeRequestSchema>

/** A comment on a Codeup change request, either on the change request itself or on a line of its diff. */
export const CodeupCommentSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  body: z.string().nullish(),
  author: CodeupUserSchema.nullish(),
  commentType: z.string().nullish(),
  state: z.string().nullish(),
  resolved: z.boolean().nullish(),
  deleted: z.boolean().nullish(),
  commentTime: z.string().nullish(),
  lastEditTime: z.string().nullish(),
  filePath: z.string().nullish(),
  line: z.number().nullish(),
})
export type CodeupComment = z.infer<typeof CodeupCommentSchema>

/** The change request a comment belongs to. */
export interface CodeupChangeRequestRef {
  localId: string | number
  detailUrl?: string | null | undefined
  sourceBranch?: string | null | undefined
}

/** The channel address of a change request: its number and, when the API gave one, the page it lives on. */
export const codeupChannel = (localId: string | number, url?: string): ChannelRef => ({
  source: SOURCE,
  thread: `${SOURCE}:${localId}`,
  address: { localId: String(localId), ...(url ? { url } : {}) },
})

/**
 * True when the account reads as a person. Codeup has no account type field, so an account whose user name or display
 * name ends with bot or robot is treated as a machine.
 */
export const isHumanLogin = (user?: { username?: string | null | undefined; name?: string | null | undefined } | null): boolean => {
  const names = [user?.username ?? '', user?.name ?? ''].map(text => text.toLowerCase())
  return !names.some(text => text.endsWith('bot') || text.endsWith('robot'))
}

/** True when the text addresses the account by its user name. */
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)

/** The names an account answers to: its display name and its platform login. */
export const codeupAccountNames = (user?: { username?: string | null | undefined; name?: string | null | undefined } | null): string[] =>
  [user?.name, user?.username].map(text => (text ?? '').trim()).filter(text => text !== '')

/**
 * The account name of an author, as the Policy's allowed list writes it: the display name first, because that is the
 * name Codeup shows and the only name the agent's own account is known by; the platform login is the fallback.
 */
export const codeupAccountName = (user?: { username?: string | null | undefined; name?: string | null | undefined } | null): string =>
  codeupAccountNames(user)[0] ?? 'ghost'

/** True when the account is the one the agent acts as, whichever of its names the API answers with. */
export const isAgentAccount = (user: { username?: string | null | undefined; name?: string | null | undefined } | null | undefined, agent: string): boolean =>
  codeupAccountNames(user).some(name => sameName(name, agent))

/** The actor of a trigger, and whether it is a person who is not the agent itself. */
const author = (user: CodeupUser | null | undefined, agent: string) => ({
  actor: { source: SOURCE, id: codeupAccountName(user) },
  human: isHumanLogin(user) && !isAgentAccount(user, agent),
})

/**
 * The text of a change request description. Codeup answers a rich text description as a JSON string that holds the
 * markup in `htmlValue`; a plain description is used as it is.
 */
export function codeupDescription(request: { description?: string | null | undefined }): string {
  const description = request.description ?? ''
  if (!description.trim().startsWith('{')) return description
  let html: unknown
  try { html = (JSON.parse(description) as { htmlValue?: unknown }).htmlValue } catch { return description }
  if (typeof html !== 'string') return description
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim()
}

/**
 * The Trigger of a change request opened in the watched repository. Its id names the change request only, so the same
 * change request is received once however often it is polled.
 */
export function changeRequestTrigger(request: CodeupChangeRequest, agent: string): Trigger {
  const localId = String(request.localId)
  const text = [request.title ?? '', codeupDescription(request)].filter(Boolean).join('\n\n')
  return {
    id: key('codeup-change-request', localId),
    source: SOURCE,
    threads: [{ source: SOURCE, id: localId }],
    ...author(request.author, agent),
    at: request.createdAt ?? new Date().toISOString(),
    text,
    channel: codeupChannel(localId, request.detailUrl ?? undefined),
    ...(request.detailUrl ? { url: request.detailUrl } : {}),
    meta: {
      localId,
      kind: 'changeRequest',
      author: codeupAccountName(request.author),
      ...(request.sourceBranch ? { sourceBranch: request.sourceBranch } : {}),
      ...(request.targetBranch ? { targetBranch: request.targetBranch } : {}),
    },
  }
}

/** The Trigger of a comment on a change request; it names the comment, so an edited comment is received again. */
export function commentTrigger(comment: CodeupComment, ref: CodeupChangeRequestRef, agent: string): Trigger {
  const localId = String(ref.localId)
  const body = comment.body ?? ''
  return {
    id: key('codeup-comment', String(comment.id)),
    source: SOURCE,
    threads: [{ source: SOURCE, id: localId }],
    ...author(comment.author, agent),
    at: comment.lastEditTime ?? comment.commentTime ?? new Date().toISOString(),
    text: body,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: codeupChannel(localId, ref.detailUrl ?? undefined),
    ...(ref.detailUrl ? { url: ref.detailUrl } : {}),
    meta: {
      localId,
      kind: 'comment',
      commentId: comment.id,
      ...(comment.commentType ? { commentType: comment.commentType } : {}),
      ...(ref.sourceBranch ? { sourceBranch: ref.sourceBranch } : {}),
      ...(comment.filePath ? { path: comment.filePath, ...(comment.line != null ? { line: comment.line } : {}) } : {}),
    },
  }
}
