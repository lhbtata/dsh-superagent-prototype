/** Codeup channel: posting a reply as a comment on the change request, and the link back to it. */
import { z } from 'zod'
import { CliError } from '../infra/commands.ts'
import type { OutboundMessage } from '../core/index.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import type { SourceContext } from './host.ts'
import { codeupCommands, codeupCommentsPath, codeupIdentifiers } from './codeup-read.ts'
import { CodeupCommentSchema } from './codeup-trigger.ts'
import { codeupPage } from './codeup-pull.ts'

/**
 * The field the comment endpoint of a change request takes the text of the comment in. Codeup's OpenAPI names this
 * field `body`, but the endpoint still has to be checked against a live token; when it turns out to be named
 * differently, this constant is the only place to change.
 */
export const CODEUP_COMMENT_BODY_FIELD = 'body'

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
 */
export async function sendCodeup(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const localId = message.channel.address.localId
  if (!localId) throw new Error('Missing Codeup reply target')
  const { organizationId, repositoryId } = codeupIdentifiers(commands)
  const path = codeupCommentsPath(organizationId, repositoryId, localId)
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const existing = await codeupCommands(commands).codeupPages(CodeupCommentSchema, path, [])
    if (existing.some(comment => (comment.body ?? '').includes(marker))) return 'sent'
    await codeupCommands(commands).codeupApi(
      z.unknown(),
      path,
      '--method',
      'POST',
      '--field',
      `${CODEUP_COMMENT_BODY_FIELD}=${message.text}\n\n${marker}`,
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
