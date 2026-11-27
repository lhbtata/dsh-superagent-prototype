# 009 Codeup setup

This document describes how to run dsh-superagent against an Aliyun Codeup repository, and holds a **draft** of the
Phase 2 configuration for the xuanjiAPP project. The draft is not applied to any running profile: the live profile
(`/home/ps/.dsh/profiles/superagent`) still points at GitHub and `lhbtata/superagent-sandbox`.

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

These are not optional. The xuanjiAPP repository does not pass them today.

1. **Secrets out of the history.** `back/src/main/java/com/xuanji/utils/ALDYUtil.java` and `ALDYUtil2.java` hold an
   Aliyun access key in clear text, and the key is in the git history as well. Rotate the key, then rewrite the
   history (or drop the file from the history) before the repository is reachable by anyone else.
2. **A Codeup personal access token.** The `codeup` CLI reads `CODEUP_TOKEN`, or `YUNXIAO_PERSONAL_TOKEN`, or
   `~/.config/codeup-agent/config.json`. The token needs read and write on the repository: the agent pushes branches
   and opens change requests.
3. **A base clone for the prepare command.** The prepare command fetches into a local clone and adds a worktree per
   ticket, so it needs its own clone, not the working copy of the operator:

   ```bash
   git clone --no-checkout git@codeup.aliyun.com:63156676050e9c4a07a96998/xuanjiAPP.git /home/ps/src/xuanjiAPP
   ```

   The worker reaches Codeup over SSH through the ssh-agent (`SSH_AUTH_SOCK` must be set for the dsh process).

4. **The project toolchain.** `pwsh` is missing on this machine, so `build/sync-dual-source.ps1` cannot run here;
   `python3 tools/check_dual_source.py` is the Linux check and it passes today.

## Phase 2: configuration draft

Values for the management API (`http://127.0.0.1:3082/orchestrator/api/`, header `x-orchestrator-request: 1`, host
`127.0.0.1`). Read the current revision with `GET /orchestrator/api/settings` first; a stale revision is rejected with
409. **Nothing below has been sent to the running profile.**

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
      "observeComments": true
    }
  }
}
```

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
      "allowed": [{ "id": "lhbtata", "name": "刘海宾" }],
      "admission": {}
    }
  }
}
```

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
  "maxWorkers": 2,
  "directory": "/home/ps/.dsh/state/superagent/work",
  "prepare": "git -C /home/ps/src/xuanjiAPP fetch --no-tags \"git@codeup.aliyun.com:$DSH_SUPERAGENT_CODEUP_REPOSITORY.git\" \"${DSH_SUPERAGENT_CODEUP_MR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET\" && git -C /home/ps/src/xuanjiAPP worktree add -b \"agent/$DSH_SUPERAGENT_NAME\" \"$DSH_SUPERAGENT_DIR\" \"refs/dsh-superagent/$DSH_SUPERAGENT_TICKET\"",
  "blockedCommands": []
}
```

The prepare command runs in the parent directory of the ticket directory. It fetches the source branch of the change
request into a ticket-scoped ref and adds a worktree named after the ticket, so the worker edits a checkout of its
own. The URL is rewritten by the worker's git configuration from `git@codeup.aliyun.com:` to the SSH form.

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
- The comment endpoint and its field names are written from the Codeup API documentation and are **not yet verified
  against a real token**. Check them before the first reply that matters.
- CI results of a Codeup project are not observed; the GitHub source's `observeCi` has no Codeup counterpart yet.
- Auto-merge is not available on Codeup, so the delivery rules of the GitHub deployment do not carry over unchanged.
