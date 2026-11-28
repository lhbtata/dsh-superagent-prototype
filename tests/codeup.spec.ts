import { afterEach, expect, it, vi } from 'vitest'
import { Commands, CliError } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { CodeupConfigSchema, codeupKind } from '../src/sources/codeup.ts'
import { codeupAccountName, codeupDescription, CodeupChangeRequestSchema, isAgentAccount } from '../src/sources/codeup-trigger.ts'
import { codeupThreadContext, readCodeup } from '../src/sources/codeup-read.ts'
import { agentChangeRequest, codeupPage } from '../src/sources/codeup-pull.ts'
import { sendCodeup } from '../src/sources/codeup-channel.ts'
import { codeupStatus } from '../src/sources/codeup-channel.ts'

const deployment = testDeployment({ host: 'codeup', repository: '63156676050e9c4a07a96998/xuanjiAPP',
  account: { cli: '/bin/false', login: 'lhbtata-superagent', noreply: 'lhbtata-superagent@users.noreply.codeup.aliyun.com' },
  codeup: { organizationId: '63156676050e9c4a07a96998', repositoryId: '5139698' } })
const commands = new Commands(() => deployment, {}, new AbortController().signal)
afterEach(() => vi.restoreAllMocks())

/** A change request as the list of a repository answers it. */
const listed = { localId: 1, title: 'Fix the margin', state: 'OPENED', createdAt: '2026-08-03T09:06:12+08:00',
  detailUrl: 'https://codeup.aliyun.com/63156676050e9c4a07a96998/xuanjiAPP/change/1', projectId: 5139698,
  sourceBranch: 'feat/fix', targetBranch: 'release/three-app-base',
  author: { name: 'lhbtata@163.com', username: 'aliyun:lhbtata@163.com_lpXMs' } }

it('reads the state of a change request from the list and from the detail, in one shape', () => {
  expect(CodeupChangeRequestSchema.parse(listed)).toMatchObject({ state: 'opened', createdAt: '2026-08-03T09:06:12+08:00' })
  expect(CodeupChangeRequestSchema.parse({ localId: 1, status: 'CLOSED', createTime: '2026-08-03T09:06:12+08:00' }))
    .toMatchObject({ state: 'closed', createdAt: '2026-08-03T09:06:12+08:00' })
})

it('names an account by its display name, and knows the agent by any of its names', () => {
  expect(codeupAccountName(listed.author)).toBe('lhbtata@163.com')
  expect(codeupAccountName({ username: 'aliyun:someone_lpXMs' })).toBe('aliyun:someone_lpXMs')
  expect(codeupAccountName(null)).toBe('ghost')
  expect(isAgentAccount({ name: 'lhbtata-superagent', username: 'aliyun:lhbtata-superagent_x' }, 'lhbtata-superagent')).toBe(true)
  expect(isAgentAccount({ name: 'lhbtata-superagent' }, 'lhbtata-superagent')).toBe(true)
  expect(isAgentAccount({ name: 'lhbtata@163.com' }, 'lhbtata-superagent')).toBe(false)
})

it('knows a change request of the agent as its own work', () => {
  const own = { author: { name: 'lhbtata-superagent', username: 'aliyun:lhbtata-superagent_x' }, projectId: 5139698 }
  expect(agentChangeRequest(own, deployment)).toBe(true)
  expect(agentChangeRequest({ ...own, author: { name: 'lhbtata@163.com' } }, deployment)).toBe(false)
})

it('admits the accounts of the Policy by display name and by platform login', () => {
  const policy = codeupKind.policy?.schema
  expect(policy).toBeDefined()
  const parsed = policy!.safeParse({ allowed: [{ id: 'lhbtata@163.com' }, { id: 'aliyun:lhbtata@163.com_lpXMs' }] })
  expect(parsed.success).toBe(true)
  expect(policy!.safeParse({ allowed: [{ id: 'not an account' }] }).success).toBe(false)
})

it('reads the description of a change request as text', () => {
  expect(codeupDescription({ description: '{"htmlValue":"<p>Hello <b>world</b></p>","jsonMLValue":[]}' })).toBe('Hello world')
  expect(codeupDescription({ description: 'plain text' })).toBe('plain text')
  expect(codeupDescription({})).toBe('')
})

it('does not read comments unless the Source is told to', () => {
  expect(CodeupConfigSchema.parse({}).observeComments).toBe(false)
  expect(CodeupConfigSchema.parse({ observeComments: true }).observeComments).toBe(true)
})

it('reads a change request with the number of its comments, without an endpoint that reads them', async () => {
  vi.spyOn(commands, 'codeupApi').mockResolvedValue({ ...listed, status: 'OPENED', state: undefined, totalCommentCount: 3, unResolvedCommentCount: 1 })
  const read = await readCodeup(commands, 'codeup/changeRequests/1/comments') as { body: { comments: number; unResolvedComments: number } }
  expect(read.body).toMatchObject({ comments: 3, unResolvedComments: 1 })
  const context = await codeupThreadContext.read(commands, { meta: { localId: 1 } } as never, 'thread', undefined, {} as never)
  expect(context.body).toMatchObject({ status: 'change_request', comments: 3 })
  expect(context.messages[0]!.text).toContain('Fix the margin')
})

it('posts a reply as a comment with the fields the endpoint takes', async () => {
  const api = vi.spyOn(commands, 'codeupApi').mockResolvedValue(undefined)
  const sent = await sendCodeup({ commands }, { id: 'm1', channel: { source: 'codeup', thread: 'codeup:1', address: { localId: '1' } },
    text: 'Done.', kind: 'reply' } as never)
  expect(sent).toBe('sent')
  expect(api).toHaveBeenCalledWith(expect.anything(), '/oapi/v1/codeup/organizations/63156676050e9c4a07a96998/repositories/5139698/changeRequests/1/comments',
    '--method', 'POST', '--field', expect.stringContaining('Done.'), '--field', 'comment_type=GLOBAL_COMMENT')
})

it('reports a change request that is gone as gone', async () => {
  vi.spyOn(commands, 'codeupApi').mockRejectedValue(new CliError('not found', 404))
  const sent = await sendCodeup({ commands }, { id: 'm2', channel: { source: 'codeup', thread: 'codeup:9', address: { localId: '9' } },
    text: 'Done.', kind: 'reply' } as never)
  expect(sent).toBe('gone')
  expect(codeupStatus(new CliError('x', 404))).toBe(404)
})

it('links to the page of a change request', () => {
  expect(codeupPage('63156676050e9c4a07a96998/xuanjiAPP', 7)).toBe('https://codeup.aliyun.com/63156676050e9c4a07a96998/xuanjiAPP/change/7')
})
