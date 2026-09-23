# aalai (ஆலை)

A software factory that sits in your menu bar. It watches your GitHub repositories, picks up new issues, and delivers a reviewed draft pull request for each one. It runs on your own machine, using the GitHub CLI you are already signed into and coding agents over the Agent Client Protocol.

Nothing merges without you. A draft pull request is the ceiling for anything the factory does unattended, and merge is not in its tool surface at all.

## Layout

```
app/
  native/            the desktop app
    src/             React, TanStack Router, shadcn, beUI motion components
    src-tauri/       the Rust shell: tray, window, sidecar supervision
packages/
  core/              the factory. Polls, plans, implements, reviews, delivers.
scripts/
  build-sidecar.ts   compiles the factory into the binary the app bundles
```

**The factory runs without the app.** `packages/core` is a normal Bun project with its own tests and evals, and none of them know a desktop app exists. The app bundles a compiled copy of it as a sidecar and supervises it; it never contains factory logic. If the shell is broken or absent, the factory still runs from a terminal.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- The [GitHub CLI](https://cli.github.com), authenticated: `gh auth status`
- A coding agent that speaks ACP. All three stations default to `codex`.
- For the desktop app: Rust 1.77 or newer and the Xcode command line tools on macOS.

## The factory, on its own

```sh
bun install
cd packages/core
cp aalai.config.example.json aalai.config.json   # then name the repos to watch
bun run src/index.ts doctor                      # gh, git and config check

bun start                                        # watch loop
bun run once                                     # one polling pass
bun run src/index.ts run owner/repo 12           # one issue, now
bun run src/index.ts status                      # recent runs
```

Install it as a background service with launchd:

```sh
bun run service install
bun run service status
bun run service uninstall
```

State lives in `~/.aalai/`. A sleeping Mac does not poll: launchd restarts the process but will not wake the machine.

## The desktop app

```sh
bun run build:sidecar          # compile the factory for this machine
cd app/native && bun run tauri dev
```

The shell spawns the factory, which binds an ephemeral port and reports it on stdout. Every launch also gets a fresh bearer token, required by every route except health. A localhost port that can open pull requests is reachable by any process on the machine, so it is not left open.

Cross compile the sidecar for another platform by naming its target triple:

```sh
bun scripts/build-sidecar.ts x86_64-pc-windows-msvc
```

## Development

```sh
bun run typecheck              # every workspace
bun run --filter aalai-core test
bun run --filter aalai-core eval
```

The two suites answer different questions. **Tests** cover pure seams: the intake screen against recorded API payloads, claim and lease semantics, convention detection, path redaction. **Evals** assert on what the factory *did*: that the stations run in order, that an approval which does not clear the gate never ships, that revisions are bounded, that an untrusted author is refused. Neither touches the network.

## What this is not, yet

The stations are not sandboxed. An agent has shell access and runs as the same user, so an already-authenticated `gh` remains reachable to it. The controls that actually hold are the disposable worktree, the independent review of the committed diff, the gate that requires every criterion to pass, and the draft status of every pull request. A sandboxed backend is the change that would make it a boundary.

There is no durable memory between runs, so nothing a run learns about a repository carries into the next one.

## License

MIT
