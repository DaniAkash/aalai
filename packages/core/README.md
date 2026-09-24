# aalai-core

**The factory. It runs without the desktop app, from a terminal.**

This package polls your watched repositories, screens new issues, and takes each accepted one through three stations to a reviewed draft pull request. The desktop app in `app/native` bundles a compiled copy of this as a sidecar and supervises it; it holds no factory logic of its own. If the app is broken or absent, everything below still works.

---

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- [GitHub CLI](https://cli.github.com), signed in. Check with `gh auth status`
- An agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com). All three stations default to `codex`
- `git` on your PATH

## Quick start

```bash
bun install
cd packages/core

bun run src/index.ts doctor     # check the machine is ready
bun run src/index.ts --once     # one pass, then exit
bun run src/index.ts            # watch forever
```

A first run creates `~/.aalai`, migrates the database, and watches nothing. Add a repository through the desktop app, or import a config file once (see [Settings](#settings)).

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

Package scripts wrap the common ones:

```bash
bun run start              # watch forever
bun run once               # a single pass
bun run run-issue acme/widgets 27
bun run test               # unit tests
bun run eval               # orchestration and prompt evals
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

Artifacts are versioned and never overwritten: `plan.v2.md` lands beside `plan.v1.md`, because approval pins to a version. There is no index table, because the paths are predictable enough that the filesystem is the index, and a table would be a cache that can lie. Deleting a subject directory by hand is safe: no row points into it.

---

## Settings

Settings live in the database, one row per domain, and the desktop app writes them. There is no config file to edit by hand.

| Domain | Keys and defaults |
| --- | --- |
| `factory` | `pollSeconds` 60 · `maxIssuesPerPoll` 25 · `staleClaimMinutes` 30 · `keepWorktreeOnFailure` true |
| `agents` | `analyst` `implementer` `reviewer` all `codex` · `reasoningEffort` high |
| `limits` | `maxRevisions` 2 · `maxCiFixes` 2 · `turnTimeoutMs` 900000 |
| `trust` | `trustedAuthorsOnly` true · `requireLabel` null |
| `commit` | `commitName` aalai · `commitEmail` |
| `ui` | `uiPort` 4173 · `notifications` true · `theme` system |

**Importing an existing config file.** Drop an `aalai.config.json` in the working directory or in `~/.aalai`, and the first start that finds empty settings imports it and renames it to `.imported`. It happens once, so editing the renamed file afterwards changes nothing.

```jsonc
{
  "watch": [{ "repo": "acme/widgets", "requireLabel": "aalai" }],
  "pollSeconds": 90,
  "maxRevisions": 3
}
```

**Running headless from a checked-in file.** `AALAI_CONFIG` points at a file and bypasses the database entirely, which is how this runs on a server where the settings belong to the deployment.

### Environment

| Variable | Default | What it is for |
| --- | --- | --- |
| `AALAI_STATE_DIR` | `~/.aalai` | Database, artifacts, run state |
| `AALAI_WORKBENCH_DIR` | `~/workbench` | Clones and worktrees |
| `AALAI_CONFIG` | unset | Read settings from this file instead of the database |
| `AALAI_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `AALAI_NO_SERVER` | unset | `1` disables the HTTP surface. The evals use it |

---

## Trust

An issue body is instructions to an agent with file and shell access, and on a public repository anyone can write one. Three things follow, and none of them are configurable away by accident:

- **Only trusted authors start a run** by default. `trustedAuthorsOnly` admits only `OWNER`, `MEMBER` and `COLLABORATOR`. Turning it off is a deliberate choice.
- **Tools that reach the outside world queue rather than send.** A station records what it would say; aalai decides whether it is said.
- **A station writes only where its run token says.** It never names its own target, so a poisoned issue body cannot talk one into writing onto another repository.

`GH_TOKEN` and friends are moved out of the ambient environment at start and handed back only to aalai's own `gh` and `git` calls, so a spawned agent does not inherit them. That narrows exposure, it is not a boundary: an agent with shell access runs as you and can call an already authenticated `gh`. The boundary that actually holds is delivery. aalai reviews the diff and pushes; the agent cannot.

---

## The HTTP surface

Always bound to `127.0.0.1`. Watching uses `uiPort`, or the port and bearer token the desktop app passes when it spawns this process, so every launch of the app gets a fresh pair. A one-shot command binds an ephemeral port behind a random token instead and takes it down when the pass ends: nothing is waiting for a handshake there, it exists so a headless run records through the same tools a watched one does. Every route but `/api/health` requires the token when one is set.

```text
GET  /api/health
GET  /api/runs
GET  /api/repos            POST /api/repos      DELETE /api/repos/:owner/:name
GET  /api/github/repos
GET  /api/events           GET  /api/live       GET /api/live/:runId
ALL  /api/mcp/:runToken    the tool surface agents call
```

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
