/** Codeup API paths, readers of change requests and comments, and the thread context of a change request. */
import { z } from 'zod'
import type { Commands, Tally } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { CodeupChangeRequestSchema, CodeupCommentSchema, codeupAccountName, codeupDescription, isHumanLogin, type CodeupChangeRequest, type CodeupComment } from './codeup-trigger.ts'
import type { CodeupConfig } from './codeup.ts'

/**
 * The base of Codeup's OpenAPI paths. The CLI takes the path it is given verbatim, so every path below starts here;
 * should the CLI turn out to add the prefix itself, this constant is the only place to change.
 */
export const CODEUP_API_BASE = '/oapi/v1/codeup'

/**
 * The Codeup CLI helpers another agent adds to `Commands`. They are reached through this view so the Source compiles
 * before that change lands; the call shapes are the ones the Codeup CLI was specified with.
 */
export interface CodeupCommands {
  codeup<T>(args: string[]): Promise<T>
  codeupApi<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  codeupPages<T>(item: z.ZodType<T>, path: string, query: readonly string[], tally?: Tally): Promise<T[]>
}

/** Views a `Commands` instance as the Codeup CLI helpers. */
export const codeupCommands = (commands: Commands): CodeupCommands => commands as unknown as CodeupCommands

/** The path of the change requests of an organization; the repository is named by the `projectIds` query parameter. */
export const codeupChangeRequestsPath = (organizationId: string): string =>
  `${CODEUP_API_BASE}/organizations/${organizationId}/changeRequests`

/** The path of one change request of a repository. */
export const codeupChangeRequestPath = (organizationId: string, repositoryId: string, localId: string | number): string =>
  `${CODEUP_API_BASE}/organizations/${organizationId}/repositories/${repositoryId}/changeRequests/${localId}`

/** The path of the comments of one change request. */
export const codeupCommentsPath = (organizationId: string, repositoryId: string, localId: string | number): string =>
  `${codeupChangeRequestPath(organizationId, repositoryId, localId)}/comments`

/** The organization the deployment works in; Codeup addresses every path by it. */
export const codeupOrganization = (commands: Commands): string => {
  const organizationId = commands.deployment.codeup?.organizationId ?? ''
  if (!organizationId) throw new Error('The Codeup organization is not configured')
  return organizationId
}

/** The organization and repository the deployment works in. */
export const codeupIdentifiers = (commands: Commands): { organizationId: string; repositoryId: string } => {
  const organizationId = codeupOrganization(commands)
  const repositoryId = commands.deployment.codeup?.repositoryId ?? ''
  if (!repositoryId) throw new Error('The Codeup repository is not configured')
  return { organizationId, repositoryId }
}

/**
 * Reads one change request. The endpoint may answer with the change request itself or wrap it in `result` or `data`,
 * so the answer is unwrapped before it is validated.
 */
const ChangeRequestEnvelopeSchema = z.unknown().transform((value, ctx) => {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const candidate = body.result ?? body.data ?? body
  const parsed = CodeupChangeRequestSchema.safeParse(candidate)
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: 'The Codeup answer holds no change request' })
    return z.NEVER
  }
  return parsed.data
})

/** Reads one change request of the repository the deployment works in. */
export async function readChangeRequest(commands: Commands, localId: string | number): Promise<CodeupChangeRequest> {
  const { organizationId, repositoryId } = codeupIdentifiers(commands)
  return codeupCommands(commands).codeupApi(ChangeRequestEnvelopeSchema, codeupChangeRequestPath(organizationId, repositoryId, localId))
}

/** Reads the change requests of the repository the deployment works in, one page at a time. */
export async function readChangeRequests(commands: Commands, query: readonly string[], tally?: Tally): Promise<CodeupChangeRequest[]> {
  const organizationId = codeupOrganization(commands)
  return codeupCommands(commands).codeupPages(CodeupChangeRequestSchema, codeupChangeRequestsPath(organizationId), query, tally)
}

/** Reads the comments of one change request of the repository the deployment works in. */
export async function readComments(commands: Commands, localId: string | number, tally?: Tally): Promise<CodeupComment[]> {
  const { organizationId, repositoryId } = codeupIdentifiers(commands)
  return codeupCommands(commands).codeupPages(CodeupCommentSchema, codeupCommentsPath(organizationId, repositoryId, localId), [], tally)
}

/** The fields of a change request the agent reads to know what it works on. */
export interface CodeupChangeRequestSummary {
  localId: string
  title: string
  state: string
  author: string
  url: string
  sourceBranch: string
  targetBranch: string
}

/** Summarizes a change request for the agent and for the Thread it belongs to. */
export function changeRequestSummary(request: CodeupChangeRequest): CodeupChangeRequestSummary {
  return {
    localId: String(request.localId),
    title: request.title ?? '',
    state: request.state ?? '',
    author: codeupAccountName(request.author),
    url: request.detailUrl ?? '',
    sourceBranch: request.sourceBranch ?? '',
    targetBranch: request.targetBranch ?? '',
  }
}

/** Reads a change request as one message of the conversation it belongs to. */
export function codeupChangeRequestMessage(request: CodeupChangeRequest): ContextMessage {
  const summary = changeRequestSummary(request)
  return {
    id: `changeRequest:${summary.localId}`,
    from: summary.author || 'ghost',
    at: request.createdAt ?? '',
    text: [summary.title, codeupDescription(request)].filter(Boolean).join('\n\n'),
    ...(summary.url ? { url: summary.url } : {}),
  }
}

/** Reads a comment as one message of the conversation it belongs to. */
export function codeupCommentMessage(comment: CodeupComment): ContextMessage {
  const author = comment.author ?? undefined
  return {
    id: String(comment.id),
    from: codeupAccountName(author),
    at: comment.commentTime ?? '',
    text: comment.body ?? '',
    ...(isHumanLogin(author) ? {} : { bot: true as const }),
    ...(comment.deleted ? { deleted: true as const } : {}),
    ...(comment.filePath ? { path: comment.filePath, ...(comment.line != null ? { line: comment.line } : {}) } : {}),
  }
}

const RESOURCE = /^codeup\/changeRequests\/([^\/]+)(?:\/(comments))?$/

/**
 * Reads a change request or its comments as model-facing `{ id, from, at, text }` messages rather than raw Codeup
 * records.
 */
export async function readCodeup(commands: Commands, resource: string): Promise<unknown> {
  const matched = RESOURCE.exec(resource)
  if (!matched) {
    throw new Error('Use codeup/changeRequests/<number>, or append /comments for the comments of a change request')
  }
  const localId = matched[1]!
  const request = await readChangeRequest(commands, localId)
  if (matched[2]) {
    // Codeup's OpenAPI lists no endpoint that reads the comments of a change request (checked on 2026-11-28); the
    // change request itself carries the number of comments, which is what the caller gets instead of the discussion.
    const body = { ...changeRequestSummary(request), comments: request.totalCommentCount ?? 0,
      unResolvedComments: request.unResolvedCommentCount ?? 0,
      note: 'Codeup\'s OpenAPI has no endpoint that reads the comments of a change request; only their number is known.' }
    return { messages: [codeupChangeRequestMessage(request)], body, skipped: 0 }
  }
  return { messages: [codeupChangeRequestMessage(request)], body: changeRequestSummary(request), skipped: 0 }
}

/**
 * Context reader for a Codeup Trigger: it reads the change request the Trigger belongs to, with the number of
 * comments on it.
 */
export const codeupThreadContext: ThreadContext<CodeupConfig> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger) => {
    const localId = trigger.meta.localId
    if (localId === undefined || localId === null) {
      return { messages: [], body: { status: 'no_change_request' }, status: 'no_change_request' }
    }
    const request = await readChangeRequest(commands, String(localId))
    const messages = [codeupChangeRequestMessage(request)]
    const body = { status: 'change_request', localId: String(localId), messages,
      comments: request.totalCommentCount ?? 0, unResolvedComments: request.unResolvedCommentCount ?? 0 }
    return { messages, next: undefined, body }
  },
}
