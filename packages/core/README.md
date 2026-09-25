# aalai

**The factory. It runs without the desktop app, from a terminal.**

```sh
bunx aalai doctor     # check the machine is ready
bunx aalai            # watch your repositories
```

This package polls your watched repositories, screens new issues, and takes each accepted one through three stations to a reviewed draft pull request. The desktop app in `app/native` bundles a compiled copy of this as a sidecar and supervises it; it holds no factory logic of its own. If the app is broken or absent, everything below still works.

---

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- [GitHub CLI](https://cli.github.com), signed in. Check with `gh auth status`
- An agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com). All three stations default to `codex`
- `git` on your PATH

## Quick start

```sh
bunx aalai doctor     # check the machine is ready
bunx aalai --once     # one pass, then exit
bunx aalai            # watch until interrupted
```

A first run creates `~/.aalai`, migrates the database, and watches nothing. Add a repository through the desktop app, or import a config file once (see [Settings](#settings)).

### Why bunx rather than npx

aalai is written against Bun. It opens its database with `bun:sqlite`, reads and
writes through `Bun.file`, serves over `Bun.serve`, and ships as TypeScript
rather than compiled output. node cannot run any of that.

`npx aalai` still works, and does the same thing in the end: what npm installs
is a small launcher that starts node, finds Bun and hands over. `bunx` skips
that first process. Without Bun installed either way, the launcher says so and
exits rather than failing somewhere deeper.

```sh
curl -fsSL https://bun.sh/install | bash
```

### From a checkout

```sh
bun install
cd packages/core
bun run src/index.ts doctor
```

---

## Commands

| Command | What it does |
| --- | --- |
| `doctor` | Checks `gh` auth, `git`, settings and the state directory. Exits non-zero if anything is wrong |
| `status` | Recent runs as a table, with clickable pull request links |
| `--once` (or `once`) | Resumes anything unfinished, polls every watched repository once, then exits |
| *(no command)* | The same, on a timer, until interrupted |
| `run <owner/repo> <issue>` | Runs one issue now, bypassing the poll cursor. Still claims, so a demo cannot double-run |
| `forget <owner/repo> <issue>` | Drops a run record so the issue can be picked up again |
| `gates` | What is waiting on a person, oldest first. `--repo owner/name` narrows it |
| `show <gate>` | The artifact a gate is asking you to approve, rendered, with its version |
| `approve <gate>` | Let the run carry on |
| `reject <gate> --reason "..."` | Stop the run, with a reason that travels with it |
| `changes <gate> --reason "..."` | Send it back to the analyst for a new plan |

Package scripts wrap the common ones:

```sh
bun run start              # watch forever
bun run once               # a single pass
bun run run-issue acme/widgets 27
bun run test               # unit tests
bun run eval               # orchestration and prompt evals
bun run e2e                # the gate, driven through the real CLI and API
bun run service install    # run at login via launchd, macOS
```

### `doctor`

```
aalai doctor
✔ gh authenticated as you
✔ git present
✔ config valid 1 repos, codex, codex, codex
· state directory ~/.aalai
```

### `status`

```
runs
┌──────────────────────┬───────┬───────────┬──────────────┬───────┐
│ repo                 │ issue │ status    │ pull request │ error │
├──────────────────────┼───────┼───────────┼──────────────┼───────┤
│ acme/widgets         │ #27   │ delivered │ #28          │       │
└──────────────────────┴───────┴───────────┴──────────────┴───────┘
```

---

## What a run actually does

```text
poll      list issues updated since this repository's cursor
screen    is it an issue, open, from a trusted author, carrying the label?
claim     one row, one lease. A duplicate observation is harmless
worktree  a disposable checkout of its own, branched from the default branch

analyst      plans, writes the acceptance criteria, modifies nothing
implementer  writes the code against that plan, commits locally
reviewer     judges the committed diff from its own checkout
deliver      pushes and opens a draft, only on an approved verdict
```

The analyst and the reviewer run in an approve-reads permission mode and the implementer is the only one that can write, so "the analyst plans, it does not implement" is a property of the run rather than a line in a prompt. Nothing merges: a draft pull request is the ceiling, and merge is not in the tool surface at all.

### Stopping for a person

A repository's policy decides how much happens unattended:

| Policy | What it does |
| --- | --- |
| `automatic` | Straight through to a draft pull request. The default |
| `plan_gate` | The plan and the criteria need approval before any code is written |
| `triage` | Reserved for classify and report, not yet wired to the pipeline |

Under `plan_gate` the run parks after the analyst and waits. It is waiting in
the database rather than in a process, so quitting costs nothing and the answer
can come from anywhere:

```sh
aalai gates                  # acme/widgets#7  plan  v1  2h
aalai show acme/widgets#7@1790000000000:plan:1
aalai approve acme/widgets#7@1790000000000:plan:1
```

That works with the desktop app closed and with no factory running. Answering
prefers the API when one is listening, because that wakes a parked run at once;
otherwise it writes the row and the run notices within a couple of seconds. The
two are the same decision, and a factory that is not running is not an error.

**Approval pins to a version.** A gate names the artifact and the version it is
asking about. If the analyst writes `plan.v2.md` afterwards, the old gate is
superseded and answering it is refused, so approval given to one plan cannot
transfer to its replacement.

**A second answer is refused and the first stands.** Three surfaces can answer
the same gate and two of them racing is expected rather than exceptional. The
same holds for a gate that was superseded or that expired: only an open gate is
answerable, and a terminal state is terminal.

### Asking before the agent acts

`askOnPermission` turns on a second, different kind of question. When the agent
requests a permission its station's mode does not cover, the turn pauses and the
request surfaces as a gate.

This one is **not durable**. It holds the agent's turn open, so it dies with the
process and is bounded by the turn timeout. A question nobody answers in time
expires and the request falls through to the station's permission mode, which is
exactly the behaviour with the setting off. It is a question with a deadline, not
a gate you can come back to tomorrow.

Stations record what they decide by **calling tools**, not by writing prose that something has to parse. Each station is served only its own:

| Station | Tools |
| --- | --- |
| analyst | `write_plan`, `find_artifacts`, `read_artifact`, `append_conversation` |
| implementer | `find_artifacts`, `read_artifact`, `append_conversation` |
| reviewer | `write_review`, `find_artifacts`, `read_artifact`, `append_conversation` |

Only the analyst holds `write_plan`, so neither the implementer nor the reviewer can rewrite the plan the work is graded against. Every station also gets `comment_on_issue` and `reply_to_review`, which queue rather than send.

### Surviving a restart

A run is a persisted state machine. Quit mid-station and the next pass picks it up: the worktree is adopted rather than rebuilt, and a station that already finished answers from what it recorded instead of spending another agent turn.

```
unfinished runs found      count=1
resuming                   state=reviewing
worktree adopted           branch=aalai/issue-27-…
attempt already succeeded  station=analyst
```

---

## Where things are kept

```text
~/.aalai/
├── aalai.sqlite          settings, watched repos, claims, snapshots, sessions
└── work/
    └── <owner>__<repo>/
        └── issue-27/
            ├── artifacts/        what a person or an agent reads
            │   ├── plan.v1.md
            │   ├── criteria.v1.md
            │   ├── review.v1.md
            │   └── conversation.md
            └── runs/<run>/       machine state for one run
                ├── machine.json      the persisted state machine snapshot
                ├── analysis.json     the plan and the criteria, structured
                ├── review.json       the verdict, structured
                ├── run.json          what was delivered
                ├── attempts/         one document per station attempt
                └── outbox/           what a station wanted to say, unsent

~/.acpx/                  acpx keeps its own sessions. aalai does not touch it
~/workbench/              clones and disposable worktrees
```

> **SQLite holds what aalai queries. The filesystem holds what aalai reads.**

Artifacts are versioned and never overwritten: `plan.v2.md` lands beside `plan.v1.md`, because approval pins to a version. Artifacts themselves are not indexed in the database: the paths are predictable enough that the filesystem is the index, and a table would be a cache that can lie.

Run state is different. `machine_snapshots.snapshot_path`, `attempts.outcome_path` and `gates.artifact_path` each hold a path under `work/`, so deleting a subject directory by hand is only safe once nothing under it is live. Do it to a finished subject and you lose the artifacts and leave rows pointing at files that are gone; do it to an unfinished run and that run can no longer resume.

---

## Settings

Settings live in the database, one row per domain, and the desktop app writes them. There is no config file to edit by hand.

| Domain | Keys and defaults |
| --- | --- |
| `factory` | `pollSeconds` 60 · `maxIssuesPerPoll` 25 · `staleClaimMinutes` 30 · `keepWorktreeOnFailure` true · `defaultPolicy` automatic |
| `agents` | `analyst` `implementer` `reviewer` all `codex` · `reasoningEffort` high |
| `limits` | `maxRevisions` 2 · `maxCiFixes` 2 · `turnTimeoutMs` 900000 |
| `trust` | `trustedAuthorsOnly` true · `requireLabel` null · `askOnPermission` false |
| `commit` | `commitName` aalai · `commitEmail` the repository owner's GitHub noreply address |
| `ui` | `uiPort` 4173 · `notifications` true · `theme` system |

**Importing an existing config file.** Drop an `aalai.config.json` in the working directory or in `~/.aalai`, and the first start that finds empty settings imports it and renames it to `.imported`. It happens once, so editing the renamed file afterwards changes nothing.

```jsonc
{
  "watch": [{ "repo": "acme/widgets", "requireLabel": "aalai" }],
  "pollSeconds": 90,
  "maxRevisions": 3
}
```

**Running headless from a checked-in file.** `AALAI_CONFIG` points at a file, and settings are then read from it rather than from the database, which is how this runs on a server where the settings belong to the deployment. Only settings move: the database is still opened, and claims, runs, machine snapshots and sessions are still kept there.

### Environment

| Variable | Default | What it is for |
| --- | --- | --- |
| `AALAI_STATE_DIR` | `~/.aalai` | Database, artifacts, run state |
| `AALAI_WORKBENCH_DIR` | `~/workbench` | Clones and worktrees |
| `AALAI_CONFIG` | unset | Read settings from this file instead of the settings tables. Other state still goes to the database |
| `AALAI_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `AALAI_NO_SERVER` | unset | `1` skips the HTTP surface for `run` and the one-shot pass, not for watching. The evals use it |

---

## Trust

An issue body is instructions to an agent with file and shell access, and on a public repository anyone can write one. Three things follow, and none of them are configurable away by accident:

- **Only trusted authors start a run** by default. `trustedAuthorsOnly` admits only `OWNER`, `MEMBER` and `COLLABORATOR`. Turning it off is a deliberate choice.
- **Tools that reach the outside world queue rather than send.** A station records what it would say; aalai decides whether it is said.
- **A station writes only where its run token says.** It never names its own target, so a poisoned issue body cannot talk one into writing onto another repository.

`GH_TOKEN` and friends are moved out of the ambient environment at start and handed back only to aalai's own `gh` and `git` calls, so a spawned agent does not inherit them. That narrows exposure, it is not a boundary: an agent with shell access runs as you and can call an already authenticated `gh`. What holds instead is delivery. Pushing and opening the pull request are aalai's, outside the tool surface any station is served, and no station is asked to do either. That is the shape of the design, not a wall an agent with a shell could not step over, and it is why every pull request is a draft.

---

## The HTTP surface

Always bound to `127.0.0.1`, and which port depends on the command:

| Command | Port | Token |
| --- | --- | --- |
| watch, and `run` | `uiPort`, or the `--port` the desktop app passes | the `--token` the app passes, when it spawns this process |
| `--once` / `once` | an ephemeral port, torn down when the pass ends | a fresh random one |

The app owns the pair it passes, so every launch of it gets a new one. The one-shot path announces nothing because nothing is waiting for a handshake there; it exists so a headless pass records through the same tools a watched one does. Every route but `/api/health` requires the token when one is set. `AALAI_NO_SERVER=1` skips the server for `run` and the one-shot pass, which is how the evals run; watching always serves, because serving the app is what watching is for.

```text
GET   /api/health
GET   /api/runs
GET   /api/repos          POST /api/repos      DELETE /api/repos/:owner/:name
PATCH /api/repos/:owner/:name                  the per repository policy
GET   /api/github/repos
GET   /api/events         GET  /api/live       GET /api/live/:runId
GET   /api/gates          GET  /api/gates/:id  POST /api/gates/:id/answer
GET   /api/settings       PATCH /api/settings
ALL   /api/mcp/:runToken  the tool surface agents call
```

Bodies go through `zValidator`, so a client derives its payload types from the
route rather than restating them. The typed client is exported precompiled from
`aalai-core/client` as `hcWithType`, which is Hono's own remedy for the type
instantiation cost that otherwise grows with every route added.

---

## Development

```bash
bun run test        # unit tests
bun run eval        # orchestration, prompts, the machine
bun run typecheck
```

From the repository root, `bun run check` runs everything at once: biome, both typecheck projects, tests, evals, clippy and fallow, reporting every failure in one pass.

```text
src/
├── commands.ts            status and doctor
├── config.ts              the flat Config every caller reads
├── index.ts               the CLI
├── events/                the event bus the interface subscribes to
├── lib/                   gh, git, proc, log, output, redaction
├── modules/
│   ├── db/                drizzle, eight tables, embedded migrations
│   ├── settings/          one row per domain, zod over each
│   ├── sessions/          the acpx ids a station resumes from
│   ├── tools/             the MCP surface stations call
│   └── work/              artifacts and run state on disk
├── prompts/               what each station is told
├── run/                   stations, the machine, delivery
├── server/                Hono routes
├── types/                 ambient declarations, including sql-as-text
└── watch/                 polling, intake, claims, resuming
```

Migrations are generated with drizzle-kit and imported as text, so they travel inside the compiled binary:

```bash
bunx drizzle-kit generate --name=add_something   # always name it
```

## Releasing

Tags drive it. The prefix names the package, so a tag can never publish the
wrong one.

```sh
# 1. bump the version in packages/core/package.json
# 2. commit it
git commit -m "chore(release): 0.0.2"
# 3. tag and push
git tag aalai-v0.0.2
git push origin main --tags
```

The workflow then re-runs the whole check suite, packs the tarball and
installs it into a scratch directory to prove the published files actually
run, and stages the version on npm. Staged is not live: approve it with a
second factor to release it.

```sh
npm stage list aalai
npm stage approve <stage-id>
```

A draft GitHub release is created at the same time, with notes generated from
the conventional commits since the previous `aalai-v*` tag. Read it, then
publish it from the Releases page.

Authentication is npm trusted publishing over OIDC, so no token is stored
anywhere. The claim is pinned to the repository and the workflow **filename**,
which means renaming `release.yml`, or adding an `environment:` key to it,
breaks every publish. A trusted publisher cannot be edited after it is
created, only deleted and remade.
