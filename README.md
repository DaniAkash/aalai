# aalai (ஆலை)

A local-first software factory. It watches your GitHub repositories, picks up new issues, and delivers a reviewed draft pull request for each one. It runs as a background service on your own machine, using the GitHub CLI you are already signed into and coding agents over the Agent Client Protocol.

Nothing merges without you. A draft pull request is the ceiling for anything the factory does unattended, and merge is not in its tool surface at all.

## How a run works

Four stations, each with one job and a contract to the next.

```
poll ─▶ screen ─▶ claim ─▶ workspace ─▶ analyst ─▶ implementer ─▶ reviewer ─▶ deliver
        trust     lease     worktree     plan +      code +        verdict +   draft PR
        gate                             criteria    commit        evidence
                                            │                          ▲
                                            └── the criteria travel ───┘
                                                verbatim, unchanged
```

**The acceptance criteria are the contract.** The analyst writes them before any code exists, the implementer is graded against them, and the reviewer judges each one individually against the real diff. The station that writes the code never defines what done means for its own work.

**The agent edits files. aalai owns every git write and every GitHub operation.** Stations work inside throwaway worktrees and may read the repository with git, never write with it. Delivery happens outside the agent turns and is gated on a review that clears, so a turn that goes wrong produces a dirty worktree that never ships.

**The reviewer gets its own checkout.** The implementer's work is committed locally and unpushed, then a second worktree of that branch is created for the reviewer. It reads the committed diff from a directory the implementer never touched, so it cannot see working state or anything about how the change was reached.

### Each stage in order

1. **Poll.** `gh api --paginate repos/{owner}/{repo}/issues?since=…` per watched repository, sorted by `updated` ascending so the ordering matches the field `since` filters on. The REST endpoint is used rather than `gh issue list` because only it exposes `author_association`, which the screen depends on. The cursor advances only after a batch has been worked, and only as far as the batch actually reached.
2. **Screen.** Drop pull requests (the issues endpoint returns them too), drop closed issues, apply the optional label gate, and apply the author trust gate.
3. **Claim.** An insert into a SQLite table keyed on `(repo, issue)`. Polling has no delivery-once guarantee, so the claim, not the cursor, is what makes a duplicate observation harmless. Claims carry a lease, so a run killed partway through releases its issue after `staleClaimMinutes` rather than blocking it forever, and completion is fenced by that lease so a stale worker cannot overwrite a newer result.
4. **Workspace.** Clone if needed, fetch, then `git worktree add` a fresh branch off the current default branch.
5. **Conventions.** Detect `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursorrules`, and globbed rule files. Whatever exists is named in the station prompts with an instruction to read it first.
6. **Analyst.** Plans against a real checkout and writes the acceptance criteria. Runs under `approve-reads`, so "it plans, it does not implement" is a property of the run rather than a line in a prompt.
7. **Implementer.** Writes the code against that plan, verifies with the repository's own checks, and is handed the criteria it will be graded against.
8. **Commit.** aalai stages and commits locally. Build and dependency output is never staged, and anything a station staged itself is removed from the index first.
9. **Reviewer.** Reads the committed diff from its own worktree and returns a verdict with one result per criterion, each carrying evidence. Also `approve-reads`: it reports, it does not fix.
10. **Gate.** An approve verdict alone is not enough. Every criterion must pass and every one must be accounted for, or nothing is pushed.
11. **Deliver.** Push the branch, open a draft pull request whose body is the evidence chain, comment the link on the issue.

A `request_changes` verdict sends the work back with the failed criteria and blocking findings attached, at most `maxRevisions` times.

### What the isolation actually is

Be precise about this, because the difference matters.

aalai removes GitHub token variables from its own environment at startup, so an agent's child process cannot inherit them, and hands them back per command to its own gh and git calls. That is worth doing, and it is not a security boundary. An agent has shell access and runs as the same user, so an already-authenticated `gh` (credentials in the system keyring or gh's own config) remains reachable to it. No process can hide those from another process running as the same user.

So the honest statement is: **an agent is constrained by where it runs and by what aalai refuses to deliver, not by being unable to reach credentials.** The controls that genuinely hold are the disposable worktree, the independent review of the committed diff, the gate that requires every criterion to pass, and the draft status of every pull request. The prompt rules are defence in depth on top of that, not the thing doing the work.

A real boundary means running agents under a sandboxed backend or a separate account. That is the next change, and until it lands this is where the line sits.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- The [GitHub CLI](https://cli.github.com), authenticated: `gh auth status`
- A coding agent that speaks ACP. All three stations default to `codex`; anything in the [`acpx`](https://www.npmjs.com/package/acpx) registry works.

## Setup

```bash
bun install
cp aalai.config.example.json aalai.config.json
# edit aalai.config.json to name the repositories you want watched
bun run ui:install && bun run ui:build   # optional, builds the dashboard
bun run src/index.ts doctor
```

`doctor` checks that the GitHub CLI is authenticated, git is present, and the config parses.

## Running it

```bash
bun start                              # watch loop and dashboard, one process
bun run once                           # one polling pass, then exit
bun run src/index.ts run owner/repo 12 # run one issue now, ignoring the cursor
bun run src/index.ts status            # recent runs and their outcomes
bun run src/index.ts forget owner/repo 12  # drop a run record so the issue can run again
```

Install it as a background service with launchd:

```bash
bun run service install
bun run service status
bun run service uninstall
```

Logs land in `~/.aalai/logs/`. State lives in `~/.aalai/aalai.sqlite`.

A sleeping Mac does not poll. launchd restarts the process but will not wake the machine, so pair the service with a `caffeinate` or `pmset` policy if the factory needs to keep working overnight.

## The dashboard

The service serves a dashboard at `http://localhost:4173` showing the pipeline as it runs. Each station is drawn as a station: a rule whose style carries its state, its name, what it is doing, and what it produced. Dashed is queued, solid violet is working, thin white is done. The label under each arrow is what that station hands to the next one.

The left column holds the acceptance criteria from the moment the analyst writes them until the reviewer answers them one at a time with evidence. It is the only element that persists across three stations.

`present` drops to a projector-sized layout. `history` lists what previous runs produced. Issues the gate turned away appear in the footer.

It is an observer. The service runs perfectly well without it: a missing build is a message telling you to run `ui:build`, and a port already in use is a warning rather than a stopped factory.

## Configuration

`aalai.config.json`:

| Field | Default | What it does |
| --- | --- | --- |
| `pollSeconds` | `60` | Seconds between polling passes. Minimum 10. |
| `watch` | required | Array of `{ "repo": "owner/name" }` to monitor. At least one. |
| `agents` | all `"codex"` | Which agent drives each station: `analyst`, `implementer`, `reviewer`. Any id in the `acpx` registry. Point `reviewer` at a different agent for cross-vendor review. |
| `maxRevisions` | `2` | How many times the reviewer may send work back before the run gives up. |
| `reasoningEffort` | `"high"` | `low`, `medium`, `high`, or `xhigh`. Applied before each turn. |
| `trustedAuthorsOnly` | `true` | Only run on issues opened by an `OWNER`, `MEMBER`, or `COLLABORATOR`. See below. |
| `requireLabel` | `null` | Optional second gate: only act on issues carrying this label. |
| `turnTimeoutMs` | `900000` | Ceiling on a single station turn, in milliseconds. |
| `keepWorktreeOnFailure` | `true` | Leave the worktree on disk when a run fails, for debugging. A successful run always cleans up. |
| `commitName` | `"aalai"` | Commit author name. Passed per commit, never read from global git config. |
| `commitEmail` | noreply address | Commit author email. |
| `staleClaimMinutes` | `30` | How long a run may hold its claim before another pass may take it over. |
| `maxIssuesPerPoll` | `25` | Most issues one pass will process. The rest wait for the next pass. |
| `uiPort` | `4173` | Port for the dashboard and its API. |

### `trustedAuthorsOnly`

An issue body becomes instructions to an agent with file and shell access. On a public repository anyone can write one. With this on, only issues opened by accounts the repository has granted write-level trust start a run; everyone else's issues are ignored.

Turning it off makes the factory act on any new issue from anyone. That is a deliberate choice, not a default.

## Development

```bash
bun run typecheck
bun run test      # unit tests
bun run eval      # behavioural evals
cd ui && bun run typecheck
```

The two suites answer different questions. **Tests** cover pure seams: the intake screen against recorded API payloads, claim and lease semantics, convention detection, branch-name sanitisation, porcelain parsing, path redaction. **Evals** assert on what the factory *did*: that the stations run in order on the real loop, that an approval which does not clear the gate never ships, that revisions are bounded, that an empty run never reaches the reviewer, that an untrusted author is refused, and that the criteria reach both stations verbatim.

Neither touches the network.

## What this is not, yet

The stations are not sandboxed. See the isolation note above for exactly where that line currently sits: the worktree and the delivery gate are the controls, and a sandboxed backend is the change that would make it a boundary.

There is no durable memory between runs, so nothing a run learns about a repository carries into the next one.

## License

MIT
