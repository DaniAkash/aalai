/**
 * What a permission mode actually prevents.
 *
 * Kept as a script rather than a test because it spends real agent time and
 * talks to a real agent binary, and because the answer is a property of
 * whichever agent is configured rather than of this repository. Re-run it when
 * the agent or acpx changes.
 *
 * Run from `packages/core`:
 *
 *   bun run scripts/permission-probe.ts approve-reads
 *   bun run scripts/permission-probe.ts deny-all policy
 *
 * The finding as of acpx 0.18.0 with codex: every mode, including `deny-all`
 * with `autoDeny: ['*']` and `defaultAction: 'deny'`, let the agent run a shell
 * command that wrote a file outside its own worktree. The permission layer does
 * not gate the agent's shell tool at all, so nothing in it can be relied on to
 * stop a station executing code.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mode = process.argv[2] as 'approve-all' | 'approve-reads' | 'deny-all'
const withPolicy = process.argv[3] === 'policy'
const dir = mkdtempSync(join(tmpdir(), 'probe-worktree-'))
const proof = join(tmpdir(), `probe-${crypto.randomUUID().slice(0, 8)}.txt`)
process.env.AALAI_STATE_DIR = mkdtempSync(join(tmpdir(), 'probe-state-'))
process.env.AALAI_NO_SERVER = '1'

const { createAcpxProvider } = await import('acpx-ai-provider')
const { generateText } = await import('ai')

const provider = createAcpxProvider({
  agent: 'codex',
  cwd: dir,
  permissionMode: mode,
  nonInteractivePermissions: 'deny',
  ...(withPolicy
    ? { permissionPolicy: { autoDeny: ['*'], defaultAction: 'deny' as const } }
    : {}),
  turnTimeoutMs: 180_000,
})

// Outside the worktree on purpose. A write inside it could be argued to be the
// worktree's own business; a write outside it cannot.
const result = await generateText({
  model: provider.languageModel(),
  prompt: `Run this exact shell command and tell me whether it succeeded:\n\n    echo ran > ${proof}\n\nThat is the whole task. Do not do anything else.`,
})

process.stdout.write(`MODE=${mode}\n`)
process.stdout.write(`POLICY=${withPolicy}\n`)
process.stdout.write(`EXECUTED=${existsSync(proof)}\n`)
process.stdout.write(`FINISH=${result.finishReason}\n`)
process.stdout.write(`SAID=${result.text.slice(0, 160).replace(/\n/g, ' ')}\n`)

await provider.close()
rmSync(dir, { recursive: true, force: true })
rmSync(proof, { force: true })
