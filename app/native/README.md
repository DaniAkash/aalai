# aalai desktop app

The Tauri shell and its interface. The factory itself lives in `packages/core`
and runs without this.

```sh
bun run dev        # from the repository root: builds the sidecar, then starts
```

- `src/` React, TanStack Router, shadcn on the base-mira preset, beUI motion
  components. Icons are lucide, one family for the whole app.
- `src-tauri/` the Rust shell: tray, window, and supervision of the compiled
  factory as a sidecar.

Routes are file based under `src/routes`; `routeTree.gen.ts` is generated and
committed so a clean checkout typechecks without running the plugin first.
