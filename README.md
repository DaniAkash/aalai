<div align="center">

# aalai (ஆலை)

**A software factory in your menu bar. Issues in, reviewed draft pull requests out, on your own machine.**

[![Status](https://img.shields.io/badge/status-work%20in%20progress-orange)](#status)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](#requirements)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-000?logo=bun&logoColor=white)](https://bun.sh)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## Status

> 🚧 **Work in progress.** The factory runs end to end from a terminal today: it polls, plans, implements, reviews and opens draft pull requests, and it survives being killed mid-run. The desktop app around it is still being built.

## Why this exists

Coding agents are good enough now that the interesting question is no longer "can it write the code". It is: **who is watching, and what happens when nobody is?**

The usual answers are a cloud service that wants your repository, or a terminal you have to sit in front of. aalai is neither. It runs on your laptop, signs in as nothing more than the `gh` you already use, drives whichever coding agents you already have, and turns issues into reviewed draft pull requests while you do something else.

**Nothing merges without you.** A draft pull request is the ceiling for anything it does unattended, and merge is not in its tool surface at all.

---

## What it does

### Watches the repositories you pick

A poll loop per repository, with a cursor, so it sees issues once rather than repeatedly. A claim is a single row with a lease, so two observations of the same issue produce one run.

### Screens before it spends anything

An issue body is instructions for an agent with shell access, and on a public repository anyone can write one. By default only `OWNER`, `MEMBER` and `COLLABORATOR` issues start a run, and you can narrow further to a label.

### Three stations, one worktree per run

```text
analyst      plans, writes the acceptance criteria, modifies nothing
implementer  writes the code against that plan, commits locally
reviewer     judges the committed diff from its own checkout
deliver      pushes and opens a draft, only on an approved verdict
```

The analyst and the reviewer run without write permission, so "the analyst plans, it does not implement" is a property of the run rather than a line in a prompt. Every run gets its own worktree, branched from the default branch. A delivered run always cleans it up; a failed one keeps it by default, because the checkout is the evidence, and `keepWorktreeOnFailure` turns that off.

### Stations record by calling tools, not by writing prose

Each station is handed a small MCP surface scoped to its own job, over a loopback port with a per-run token. The analyst is the only one that can write a plan; the reviewer is the only one that can write a verdict. Nothing has to parse an agent's paragraph to find out what it decided.

### Artifacts are the memory

The plan, the acceptance criteria, the review and the conversation are versioned markdown on disk. `plan.v2.md` lands beside `plan.v1.md` rather than over it, because approval pins to a version. A later station reads what an earlier one wrote through the same tool a person would use to read it, and it can recall across the whole repository, so a new issue starts with what earlier ones already worked out.

### It survives a restart

A run is a persisted state machine. Quit in the middle of the reviewer and the next pass resumes it: the worktree is adopted rather than rebuilt, and a station that already finished answers from what it recorded instead of spending another agent turn.

### It stops for you when you ask it to

A repository's policy decides how much happens unattended: straight through to a
draft pull request, or parked after the analyst until a person approves the plan
and the acceptance criteria. Parked means parked in the database, not in a
process, so quitting costs nothing and the answer can come from anywhere:

```sh
aalai gates                    # what is waiting on you
aalai approve <gate>           # works with the app closed
```

Approval pins to a version, so a plan rewritten afterwards does not inherit the
approval its predecessor was given.

### Nothing merges

The draft pull request is the artefact. Pushing and opening it are aalai's, outside the tool surface any station is served, and no station is asked to do either. That is a property of the design rather than a wall: see the sandbox note below.

---

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- The [GitHub CLI](https://cli.github.com), authenticated: `gh auth status`
- A coding agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com). All three stations default to `codex`
- For the desktop app: Rust 1.77 or newer, plus the Xcode command line tools on macOS

## The factory, on its own

`packages/core` is a normal Bun project with its own tests and evals, and none of them know a desktop app exists. Everything below works with no app installed.

```sh
bun install
cd packages/core

bun run src/index.ts doctor            # gh, git and settings check
bun run src/index.ts --once            # one polling pass, then exit
bun run src/index.ts                   # watch until interrupted
bun run src/index.ts run owner/repo 12 # one issue, now
bun run src/index.ts status            # recent runs
```

Run it in the background with launchd:

```sh
bun run service install
bun run service status
bun run service uninstall
```

A sleeping Mac does not poll: launchd restarts the process but will not wake the machine.

→ **[packages/core/README.md](./packages/core/README.md)** for the full CLI guide: every command, every setting, the storage layout and the tool surface.

## The interface, two ways

The app is a Tauri window and a plain web page, and neither is a degraded copy
of the other. The factory speaks HTTP, so a browser is a first class client.

```sh
bun run dev        # the desktop window, with its own sidecar
bun run dev:web    # the factory plus the page at localhost:5173
```

That is the whole setup. There is no config file to copy: settings live in the
database, and repositories are added by picking from what your `gh` account
already owns.

What differs between them is the transport, and only the transport:

| | desktop | web |
| --- | --- | --- |
| reaches the factory by | Tauri's HTTP plugin | the browser's `fetch` |
| address | an ephemeral port the shell reports | `/api`, proxied by Vite |
| authentication | a token per launch | held by the proxy, never in the page |
| needs CORS | no, requests go through Rust | no, requests are same origin |

Point the web build at a factory elsewhere, or at one you started with a token,
with `AALAI_API_URL` and `AALAI_API_TOKEN`. Both are read by the Vite proxy,
which runs in node, so a secret stays out of the browser exactly as it stays
out of the webview.

Features that only the desktop window can offer are wrapped so they simply are
not there on the web, rather than breaking the page around them.

The shell spawns the factory, which binds a port and reports it on stdout. Every launch also gets a fresh bearer token, required by every route except health. A localhost port that can open pull requests is reachable by any process on the machine, so it is not left open.

Cross compile the sidecar for another platform by naming its target triple:

```sh
bun scripts/build-sidecar.ts x86_64-pc-windows-msvc
```

---

## Layout

```text
app/
  native/            the desktop app
    src/             React, TanStack Router, shadcn, beUI motion components
    src-tauri/       the Rust shell: tray, window, sidecar supervision
packages/
  core/              the factory. Polls, plans, implements, reviews, delivers
scripts/
  build-sidecar.ts   compiles the factory into the binary the app bundles
```

**The factory runs without the app.** The app bundles a compiled copy of it as a sidecar and supervises it; it holds no factory logic. If the shell is broken or absent, the factory still runs from a terminal.

## Development

```sh
bun run check      # biome, typecheck, tests, evals, clippy and dead-code, in one pass
bun run test
bun run eval
```

The two suites answer different questions. **Tests** cover pure seams: the intake screen against recorded API payloads, claim and lease semantics, atomic writes, path redaction. **Evals** assert on what the factory *did*: that the stations run in order, that an approval which does not clear the gate never ships, that a resumed run does not re-run a station that already succeeded, that an untrusted author is refused. Neither touches the network.

---

## What this is not, yet

**The stations are not sandboxed.** An agent has shell access and runs as the same user, so an already authenticated `gh` remains reachable to it. The controls that actually hold are the disposable worktree, the independent review of the committed diff, the gate that requires every criterion to pass, and the draft status of every pull request. A sandboxed agent backend is the change that would make it a boundary.

**Nothing carries between repositories.** Artifacts are the memory, and a station can recall across the whole repository it is working in, so a later issue can read an earlier one's plan or review. Nothing reaches past that repository, and there is no summarised, cross-repository memory yet.

## Roadmap

Already shipped:

- ✅ Durable storage: claims, leases, cursors and versioned artifacts that survive a crash
- ✅ The full station pipeline, end to end, to a draft pull request
- ✅ A state machine per run, persisted, resumable across process restarts
- ✅ An MCP tool surface per station, scoped and token gated
- ✅ Trust screening, redaction, and outbound intents that queue rather than send
- ✅ Human gates: a run parks for a person and is answerable from a terminal

Coming next:

- 🚧 The desktop app: live runs, approvals and settings
- 🚧 Pull request lifecycle: review comments and CI failures back into the loop
- 🚧 Notifications and packaging

---

## License

MIT, see [LICENSE](./LICENSE).

Copyright © 2026 [Dani Akash](https://github.com/DaniAkash). If you build on this project, please retain the copyright notice as required by the MIT License.
