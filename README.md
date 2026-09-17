# aalai (ஆலை)

A local-first software factory. It watches your GitHub repositories, picks up new issues, and delivers a draft pull request for each one. It runs as a background service on your own machine, using the GitHub CLI you are already signed into and a coding agent over the Agent Client Protocol.

Nothing merges without you. A draft pull request is the ceiling for anything the factory does unattended.

## How a run works

```
gh api issues ─▶ screen ─▶ claim ─▶ worktree ─▶ agent ─▶ verify diff ─▶ commit + push ─▶ draft PR
                (sqlite)              (cwd)      ▲                       ▲
                                                 │                       │
                                 no credentials reach the agent ─────────┘
```

The split in that diagram is the design. **The agent edits files. aalai does every git and GitHub operation.** The agent works inside a throwaway worktree, holds no token, and is instructed not to run git at all. Delivery happens outside the agent turn and is gated on a real diff, so the worst outcome from a turn that goes wrong is a dirty worktree that never ships.

Each stage in order:

1. **Poll.** `gh api repos/{owner}/{repo}/issues?since=…` per watched repository. The REST endpoint is used rather than `gh issue list` because only it exposes `author_association`, which the screen depends on.
2. **Screen.** Drop pull requests (the issues endpoint returns them too), drop closed issues, apply the optional label gate, and apply the author trust gate.
3. **Claim.** An insert into a SQLite table keyed on `(repo, issue)`. Polling has no delivery-once guarantee, so the claim, not the cursor, is what makes a duplicate observation harmless.
4. **Workspace.** Clone if needed, fetch, then `git worktree add` a fresh branch off the current default branch. Every run gets its own worktree, so no run can inherit another's leftovers.
5. **Conventions.** Detect `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursorrules`, and globbed rule files. Whatever exists is named in the agent's prompt with an instruction to read it first.
6. **Agent.** One turn through `acpx-ai-provider`, with the worktree as its working directory.
7. **Verify.** `git status --porcelain`. No diff means no pull request, and the issue gets a comment saying so.
8. **Deliver.** Commit, push the branch, open a draft pull request, comment the link on the issue.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- The [GitHub CLI](https://cli.github.com), authenticated: `gh auth status`
- A coding agent that speaks ACP. The default is `codex`; anything in the [`acpx`](https://www.npmjs.com/package/acpx) registry works.

## Setup

```bash
bun install
cp aalai.config.example.json aalai.config.json
# edit aalai.config.json to name the repositories you want watched
bun run src/index.ts doctor
```

`doctor` checks that the GitHub CLI is authenticated, git is present, and the config parses.

## Running it

```bash
bun start                              # run the watch loop in the foreground
bun run once                           # one polling pass, then exit
bun run src/index.ts run owner/repo 12 # run one issue now, ignoring the cursor
bun run src/index.ts status            # recent runs and their outcomes
```

Install it as a background service with launchd:

```bash
bun run service install
bun run service status
bun run service uninstall
```

Logs land in `~/.aalai/logs/`. State lives in `~/.aalai/aalai.sqlite`.

A sleeping Mac does not poll. launchd restarts the process but will not wake the machine, so pair the service with a `caffeinate` or `pmset` policy if the factory needs to keep working overnight.

## Configuration

`aalai.config.json`:

| Field | Default | What it does |
| --- | --- | --- |
| `pollSeconds` | `60` | Seconds between polling passes. Minimum 10. |
| `watch` | required | Array of `{ "repo": "owner/name" }` to monitor. At least one. |
| `agent` | `"codex"` | Any agent id in the `acpx` registry. |
| `reasoningEffort` | `"high"` | `low`, `medium`, `high`, or `xhigh`. Applied before the turn. |
| `trustedAuthorsOnly` | `true` | Only run on issues opened by an `OWNER`, `MEMBER`, or `COLLABORATOR`. See below. |
| `requireLabel` | `null` | Optional second gate: only act on issues carrying this label. |
| `turnTimeoutMs` | `900000` | Ceiling on a single agent turn, in milliseconds. |
| `keepWorktreeOnFailure` | `true` | Leave the worktree on disk when a run fails, for debugging. |
| `commitEmail` | noreply address | Email used as the commit author. |

### `trustedAuthorsOnly`

An issue body becomes instructions to an agent with file and shell access. On a public repository anyone can write one. With this on, only issues opened by accounts the repository has granted write-level trust start a run; everyone else's issues are ignored.

Turning it off makes the factory act on any new issue from anyone. That is a deliberate choice, not a default.

## Development

```bash
bun run typecheck
bun test
```

Tests cover the three seams worth pinning: the intake screen against recorded API payloads, the claim semantics against an in-memory database, and convention detection against real directory trees. None of them touch the network.

## What this is not, yet

One agent, one turn, one pull request. There is no separate classifier, no independent reviewer, no durable memory between runs, and no revision loop. Those are the next thing, not a missing thing.

## License

MIT
