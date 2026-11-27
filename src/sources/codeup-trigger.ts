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
 */
export const CodeupChangeRequestSchema = z.looseObject({
  localId: z.union([z.number(), z.string()]),
  title: z.string().nullish(),
  state: z.string().nullish(),
  detailUrl: z.string().nullish(),
  description: z.string().nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  mergedAt: z.string().nullish(),
  closedAt: z.string().nullish(),
  merged: z.boolean().nullish(),
  projectId: z.union([z.string(), z.number()]).nullish(),
  sourceBranch: z.string().nullish(),
  targetBranch: z.string().nullish(),
  author: CodeupUserSchema.nullish(),
})
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

/** The account name of an author, falling back to the display name and then to an unknown author. */
const loginOf = (user?: { username?: string | null | undefined; name?: string | null | undefined } | null): string =>
  user?.username ?? user?.name ?? 'ghost'

/** The actor of a trigger, and whether it is a person who is not the agent itself. */
const author = (user: CodeupUser | null | undefined, agent: string) => ({
  actor: { source: SOURCE, id: loginOf(user) },
  human: isHumanLogin(user) && !sameName(loginOf(user), agent),
})

/**
 * The Trigger of a change request opened in the watched repository. Its id names the change request only, so the same
 * change request is received once however often it is polled.
 */
export function changeRequestTrigger(request: CodeupChangeRequest, agent: string): Trigger {
  const localId = String(request.localId)
  const text = [request.title ?? '', request.description ?? ''].filter(Boolean).join('\n\n')
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
      author: loginOf(request.author),
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
