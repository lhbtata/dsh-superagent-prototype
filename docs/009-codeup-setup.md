# 009 Codeup setup

This document describes how to run dsh-superagent against an Aliyun Codeup repository, and holds the Phase 2
configuration for the xuanjiAPP project. It was applied to the live profile (`/home/ps/.dsh/profiles/superagent`) on
2026-11-28: the instance works on Codeup and `63156676050e9c4a07a96998/xuanjiAPP`; the GitHub Source is switched off.

It builds on [006 Deployment](006-deployment.md) (the settings blocks and the management API) and
[008 Cookbook](008-cookbook.md) (what a Source kind is).

## What the Codeup Source is

The Codeup Source is the third Source kind, next to GitHub and Feishu. It reads Codeup change requests (merge
requests) and their comments, opens a change request for finished work, and closes the ticket when a human merges it.
Nothing in the domain model changed: a Source is a Source, and Codeup is one more of them.

A deployment works on **one** code host. The panel picks the host when the settings are saved: `sources.codeup` enabled
with a repository means Codeup, otherwise GitHub. Everything below the setup layer reads `deployment.host`, so the
GitHub behaviour is unchanged.

| Piece | File |
| --- | --- |
| Source kind, watch loop, policy, environment | `src/sources/codeup.ts` |
| Trigger shapes (change request, comment) | `src/sources/codeup-trigger.ts` |
| Reading change requests and comments | `src/sources/codeup-read.ts` |
| Pull/merge-request binding | `src/sources/codeup-pull.ts` |
| Replying on a change request | `src/sources/codeup-channel.ts` |
| Worker skill (what the agent reads and how) | `skills/dsh-superagent-codeup/SKILL.md` |
| The `codeup` CLI the worker runs | `tools/codeup-agent/codeup` |

The bundle `dsh-superagent/codeup-watch` is inserted by `cordis.patch.yml` and **disabled by default**. Enable it in
the profile before configuring the Source.

## Phase 0: what has to be true first

Status on 2026-11-28: items 1 to 4 are done, item 5 is committed but not pushed.

1. **Secrets out of the history** — WAIVED by the repository owner on 2026-11-27: the Aliyun access key in
   `back/src/main/java/com/xuanji/utils/ALDYUtil.java` and `ALDYUtil2.java` stays as it is. The key is still in the
   git history, so the repository must stay inside the people who already have it.
2. **A Codeup personal access token.** The `codeup` CLI reads `CODEUP_TOKEN`, or `YUNXIAO_PERSONAL_TOKEN`, or
   `~/.config/codeup-agent/config.json`. The token needs read and write on the repository: the agent pushes branches
   and opens change requests. To obtain one: Aliyun Yunxiao → personal settings → personal access tokens → create a
   token with repository read and write. Copy the template `/home/ps/.config/codeup-agent/config.json.example` to
   `/home/ps/.config/codeup-agent/config.json`, fill in the token, and get the repository id with
   `codeup api repos/63156676050e9c4a07a96998/xuanjiAPP` (it answers `id` and `permissions`). Keep that file at
   mode 600; the CLI reads the token from it and never writes it back. **DONE on 2026-11-28**: the file exists, and the
   account behind it is the dedicated agent account `lhbtata-superagent`, not the operator's own account.
3. **A base clone for the prepare command** — DONE. The prepare command fetches into a local clone and adds a
   worktree per ticket, so it needs its own clone, not the working copy of the operator:

   ```bash
   git clone git@codeup.aliyun.com:63156676050e9c4a07a96998/xuanjiAPP.git /home/ps/src/xuanjiAPP
   git -C /home/ps/src/xuanjiAPP checkout -b base origin/release/three-app-base
   ```

   Two traps, both hit and fixed on this machine:

   - `git clone --no-checkout` leaves HEAD on a remote-tracking branch, and `git worktree add -b` then fails with
     "fatal: HEAD does not point to a branch" — every ticket would have failed its prepare step.
   - The remote's HEAD is `master`, last touched 2025-07-21 and 1047 commits behind the working branch. The prepare
     command names the base branch explicitly, because a bare `HEAD` fallback checks out the wrong code.

   The worker reaches Codeup over SSH through the ssh-agent (`SSH_AUTH_SOCK` must be set for the dsh process).

4. **The project toolchain** — DONE. PowerShell 7.7.0 is installed for the operator account
   (`/home/ps/.local/opt/powershell`, `pwsh` on PATH through `/home/ps/.local/bin`), so
   `build/sync-dual-source.ps1` runs here; `python3 tools/check_dual_source.py` stays the Linux check and it passes
   today.
5. **Audit run logs out of the index** — DONE, not pushed. The 186 `*.log` files under
   `docs/farming-task-catalog/ops/audit/health/` are re-runnable output (one of them reached 106 MB in the history),
   so they were untracked and ignored. The `summary.tsv` and `*.csv` / `*.md` / `*.json` conclusions in the same
   directories stay tracked. Commit `63a2ddbd` on `release/three-app-base` of the working copy.

## Phase 2: configuration

Values for the management API (`http://127.0.0.1:3082/orchestrator/api/`, header `x-orchestrator-request: 1`, host
`127.0.0.1`). Read the current revision with `GET /orchestrator/api/settings` first; a stale revision is rejected with
409. **The values below were applied to the live profile on 2026-11-28.**

### sources

```json
{
  "codeup": {
    "enabled": true,
    "config": {
      "repository": "63156676050e9c4a07a96998/xuanjiAPP",
      "cli": "/home/ps/.local/bin/codeup",
      "pollSeconds": 60,
      "failuresBeforeError": 3,
      "observeChangeRequests": true,
      "observeComments": false
    }
  }
}
```

`observeComments` is off because Codeup's OpenAPI has no endpoint that reads the comments of a change request (every
variant answered 404 on 2026-11-28). The number of comments is read all the same, and the agent's own replies are
posted to the change request; it just cannot see what a human wrote there.

The GitHub Source was switched off in the same save, so the deployment has exactly one code host.

The CLI itself is configured outside the panel, in `~/.config/codeup-agent/config.json`:

```json
{
  "domain": "codeup.aliyun.com",
  "token": "<personal access token>",
  "organizationId": "63156676050e9c4a07a96998",
  "repositoryId": "<repository id from: codeup api repos/63156676050e9c4a07a96998/xuanjiAPP>",
  "owner": "63156676050e9c4a07a96998",
  "repository": "xuanjiAPP"
}
```

Saving the Sources block runs the setup check (`codeup api user` must answer, and the repository must report push
permission) and restarts the plugin. A failed check pauses the whole runtime, so do it with the profile in reach.

### policy

```json
{
  "rules": [
    {
      "id": "tooling",
      "name": "Tooling and scripts",
      "enabled": true,
      "instruction": "Explicit requests to change the project's own scripts under tools/ or build/ (Python or shell), such as the dual-source check, the lifecycle scanner or the page-boundary gates. Keep the change small, keep the script runnable on Linux, and state which command proves the change works."
    },
    {
      "id": "docs",
      "name": "Documentation",
      "enabled": true,
      "instruction": "Explicit requests to write or correct documentation, comments and READMEs. Keep the wording of the project, do not restate secrets, and do not document values that only live in a deployment's environment."
    },
    {
      "id": "frontend",
      "name": "Frontend pages",
      "enabled": true,
      "instruction": "Explicit implementation requests for a page or component of the uni-app front end. The truth lives in shared/ and apps/<product>/, and the root copy is generated: change the truth, run the sync script, and check the result with the dual-source check. Never define a page lifecycle hook twice, and run the lifecycle scanner before the change is ready. Do not touch the back end service, the production configuration or any secret."
    }
  ],
  "sources": {
    "codeup": {
      "allowed": [{ "id": "lhbtata@163.com" }],
      "admission": {}
    }
  }
}
```

A Codeup account is named by its display name, which is usually an email address (`lhbtata@163.com`), or by its platform
login, which carries the `aliyun:` prefix (`aliyun:lhbtata@163.com_lpXMs`). The Source accepts both forms, and the
agent's own account (`lhbtata-superagent`) is never a candidate: its own change requests are skipped when the Source
reads them.

The `admission` table is filled from the panel once the Source is on: it decides who may open a ticket with an
explicit request, and who may only open one that the rules infer. Leave it empty at first and watch what the panel
reports; an empty allowed list means nobody can open a ticket at all.

### eval

```json
{ "mode": "auto", "timeoutSeconds": 300, "model": null }
```

`observe` only records what the agent would have done. `auto` is what makes it work, so it is the switch to flip when
the pilot starts, not before.

### executor

```json
{
  "model": null,
  "maxWorkers": 3,
  "directory": "/home/ps/.dsh/state/superagent/work",
  "prepare": "git -C /home/ps/src/xuanjiAPP fetch --no-tags \"git@codeup.aliyun.com:$DSH_SUPERAGENT_CODEUP_REPOSITORY.git\" \"refs/heads/${DSH_SUPERAGENT_CODEUP_MR_HEAD:-release/three-app-base}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET\" && git -C /home/ps/src/xuanjiAPP worktree add -b \"agent/$DSH_SUPERAGENT_NAME\" \"$DSH_SUPERAGENT_DIR\" \"refs/dsh-superagent/$DSH_SUPERAGENT_TICKET\"",
  "blockedCommands": []
}
```

The prepare command runs in the parent directory of the ticket directory. It fetches the source branch of the change
request into a ticket-scoped ref and adds a worktree named after the ticket, so the worker edits a checkout of its
own. The URL is rewritten by the worker's git configuration from `git@codeup.aliyun.com:` to the SSH form.

The fallback after `DSH_SUPERAGENT_CODEUP_MR_HEAD` is `release/three-app-base`, not `HEAD`: the remote's `HEAD` is
`master`, which stopped moving on 2025-07-21. The source branch of a change request is a plain branch name, so the
command prefixes it with `refs/heads/`; the fallback carries the same prefix. With the fallback in place, a ticket
without a change request still starts from the current development branch — verified end to end on 2026-11-28 by
running the prepare command against `/home/ps/src/xuanjiAPP` and adding a worktree.

### prompts

The team paragraphs in the panel carry the project rules. The delivery paragraph for Codeup differs from GitHub in
three places:

- Delivery is a **merge request a human reviews**. The agent never merges and never enables auto-merge: Codeup's
  merge API is not wired into the agent's CLI, and a change request that merges itself is exactly what the review
  rules exist to prevent.
- The commit author is the agent account the deployment reports, not the person who asked.
- Before and after evidence for a UI change goes into the merge request description, as on GitHub.

## Phase 3: the first slices

Start with work that cannot touch production and cannot leak a secret:

1. `tools/*.py` and `build/*.sh` under the `tooling` rule.
2. Documentation under the `docs` rule.
3. One page change under the `frontend` rule, with the dual-source check and the lifecycle scanner as the
   acceptance criteria.

Each slice ends in a change request on Codeup that a human merges. The ticket closes when the merge is seen.

Stop conditions: a ticket that needs the back end service, the production configuration, a secret or a database
migration is out of scope for the pilot and is left to a person.

## Known gaps

- The `codeup` CLI has no `--jq`, `--paginate` or `--include`. Paging is done by hand with `--query page=N
  --query perPage=50`, and JSON is filtered on the TypeScript side.
- The CLI percent-encodes every `--query` value itself, so a value must be passed as it is: a pre-encoded date
  arrives twice encoded (`2026-11-28T03%3A56%3A29.144Z`) and the API answers 400.
- **There is no endpoint that reads the comments of a change request.** Every variant answered 404 on 2026-11-28
  (`…/changeRequests/<id>/comments` with GET and POST, the GitLab-shaped path on `openapi-rdc`, and the web path on
  `codeup.aliyun.com`). The Source therefore reads the change request and its comment counts instead of the comments,
  and `observeComments` is off. The reply path works: a comment is posted with `content` and
  `comment_type=GLOBAL_COMMENT`.
- The list of change requests is organization-wide; the repository is named by the `projectIds` query parameter. The
  `state` filter takes the lowercase values `opened`, `closed`, `merged` and `all`; any other casing is ignored and
  returns everything.
- The list answers `state` and `createdAt`, the detail answers `status` and `createTime`. The Source folds the two
  names into one shape.
- CI results of a Codeup project are not observed; the GitHub source's `observeCi` has no Codeup counterpart yet.
- Auto-merge is not available on Codeup, so the delivery rules of the GitHub deployment do not carry over unchanged.
- Git access is over SSH, so a push is attributed to the SSH key of the machine, while the API acts as the dedicated
  agent account `lhbtata-superagent`. The commit author is set explicitly by the worker.
