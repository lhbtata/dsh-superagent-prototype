/** Codeup channel: posting a reply as a comment on the change request, and the link back to it. */
import { z } from 'zod'
import { CliError } from '../infra/commands.ts'
import type { OutboundMessage } from '../core/index.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import type { SourceContext } from './host.ts'
import { codeupCommands, codeupCommentsPath, codeupIdentifiers } from './codeup-read.ts'
import { codeupPage } from './codeup-pull.ts'

/**
 * The fields the comment endpoint of a change request takes. Codeup's OpenAPI creates a comment with the text in
 * `content` and the kind of comment in `comment_type` (checked against a live token on 2026-11-28); it has no field
 * for the comment a reply answers, so a reply is a new comment on the change request.
 */
export const CODEUP_COMMENT_FIELDS = { content: 'content', type: 'comment_type' } as const

/** The kind of comment the endpoint takes for a comment on the change request itself. */
export const CODEUP_COMMENT_TYPE = 'GLOBAL_COMMENT'

/**
 * The HTTP status a failure carries. The Codeup CLI reports errors as one line of JSON on stderr, and the error the
 * commands layer raises keeps the status in its code; the message is read as a second hand, so a reply that must not
 * be retried is recognized however the CLI reported it.
 *
 * The Codeup CLI writes its status as `error.status`, while the commands layer reads `error.code`; until the two are
 * the same, a failing status that the CLI only prints is not recognised, and the reply fails loudly instead of
 * quietly disappearing.
 */
export const codeupStatus = (error: unknown): number | undefined => {
  if (error instanceof CliError && typeof error.code === 'number') return error.code
  const message = error instanceof Error ? error.message : String(error)
  const matched = /"status"\s*:\s*(\d+)/.exec(message) ?? /\b(?:http\s+)?(\d{3})\b/i.exec(message)
  return matched?.[1] ? Number(matched[1]) : undefined
}

/**
 * Posts the reply of the agent as a comment on the change request it belongs to. A change request that is gone makes
 * the reply a `gone`, every other failure is thrown so the caller can report it.
 *
 * Codeup's OpenAPI lists no endpoint that reads the comments of a change request, so a reply cannot be checked
 * against the ones already there; the marker in its text tells a person which replies belong to the agent.
 */
export async function sendCodeup(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const localId = message.channel.address.localId
  if (!localId) throw new Error('Missing Codeup reply target')
  const { organizationId, repositoryId } = codeupIdentifiers(commands)
  const path = codeupCommentsPath(organizationId, repositoryId, localId)
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    await codeupCommands(commands).codeupApi(
      z.unknown(),
      path,
      '--method',
      'POST',
      '--field',
      `${CODEUP_COMMENT_FIELDS.content}=${message.text}\n\n${marker}`,
      '--field',
      `${CODEUP_COMMENT_FIELDS.type}=${CODEUP_COMMENT_TYPE}`,
    )
    return 'sent'
  } catch (error) {
    const status = codeupStatus(error)
    if (status === 404 || status === 410) return 'gone'
    throw error
  }
}

/** The link to the change request a reply belongs to. */
export function codeupLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const localId = address.localId ?? ''
  const url = address.url ?? (links.repository ? codeupPage(links.repository, localId) : '')
  return {
    url,
    label: { zh: `Codeup 变更请求 #${localId}`, en: `Codeup change request #${localId}` },
  }
}
