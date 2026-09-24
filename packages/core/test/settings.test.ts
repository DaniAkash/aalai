import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '@/config'
import { openDb, setDb } from '@/modules/db/db'
import {
  readDomain,
  readWatchedRepos,
  settingsAreEmpty,
  writeDomain,
  writeWatchedRepos,
} from '@/modules/settings/settings'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-settings-'))
  process.env.AALAI_STATE_DIR = dir
  delete process.env.AALAI_CONFIG
  setDb(openDb(join(dir, 'aalai.sqlite')))
})

afterEach(() => {
  setDb(undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('settings domains', () => {
  test('a domain round trips', () => {
    const { sqlite } = openDb(join(dir, 'aalai.sqlite'))
    writeDomain(sqlite, 'factory', {
      pollSeconds: 120,
      maxIssuesPerPoll: 5,
      staleClaimMinutes: 15,
      keepWorktreeOnFailure: false,
      defaultPolicy: 'automatic' as const,
    })
    expect(readDomain(sqlite, 'factory')).toEqual({
      pollSeconds: 120,
      maxIssuesPerPoll: 5,
      staleClaimMinutes: 15,
      keepWorktreeOnFailure: false,
      defaultPolicy: 'automatic' as const,
    })
  })

  test('an unwritten domain reads as its defaults', () => {
    const { sqlite } = openDb(join(dir, 'aalai.sqlite'))
    expect(readDomain(sqlite, 'limits').maxRevisions).toBe(2)
  })

  test('a row that is not json falls back rather than failing the boot', () => {
    const { sqlite } = openDb(join(dir, 'aalai.sqlite'))
    sqlite
      .query('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('agents', 'not json at all')
    expect(readDomain(sqlite, 'agents').analyst).toBe('codex')
  })

  test('a row that is json but wrong falls back too', () => {
    const { sqlite } = openDb(join(dir, 'aalai.sqlite'))
    sqlite
      .query('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('ui', JSON.stringify({ uiPort: 'not a number' }))
    expect(readDomain(sqlite, 'ui').uiPort).toBe(4173)
  })

  test('one bad domain does not take the others down', () => {
    const { sqlite } = openDb(join(dir, 'aalai.sqlite'))
    writeDomain(sqlite, 'factory', {
      pollSeconds: 90,
      maxIssuesPerPoll: 25,
      staleClaimMinutes: 30,
      keepWorktreeOnFailure: true,
      defaultPolicy: 'automatic' as const,
    })
    sqlite
      .query('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('agents', '{{{')
    expect(readDomain(sqlite, 'factory').pollSeconds).toBe(90)
    expect(readDomain(sqlite, 'agents').reviewer).toBe('codex')
  })
})

describe('config over settings', () => {
  test('saving and loading preserves what was set', async () => {
    const before = await loadConfig()
    await saveConfig({
      ...before,
      pollSeconds: 300,
      maxRevisions: 4,
      watch: [{ repo: 'acme/widgets', requireLabel: 'ready' }],
    })
    const after = await loadConfig()
    expect(after.pollSeconds).toBe(300)
    expect(after.maxRevisions).toBe(4)
    expect(after.watch).toEqual([
      { repo: 'acme/widgets', requireLabel: 'ready' },
    ])
  })

  test('a fresh install watches nothing and still starts', async () => {
    const config = await loadConfig()
    expect(config.watch).toEqual([])
    expect(config.agents.analyst).toBe('codex')
  })
})

describe('replacing the watched set', () => {
  test('a duplicate repository collapses instead of erasing the set', () => {
    const { sqlite } = openDb(join(dir, 'aalai.sqlite'))
    writeWatchedRepos(sqlite, [{ repo: 'acme/widgets' }])

    writeWatchedRepos(sqlite, [
      { repo: 'acme/other' },
      { repo: 'acme/other', requireLabel: 'ready' },
    ])

    expect(readWatchedRepos(sqlite)).toEqual([
      { repo: 'acme/other', requireLabel: 'ready' },
    ])
  })

  test('a per repository policy survives the round trip', () => {
    const { sqlite } = openDb(join(dir, 'aalai.sqlite'))

    writeWatchedRepos(sqlite, [
      { repo: 'acme/widgets', policy: 'plan_gate', requireLabel: 'aalai' },
    ])

    // Read back rather than trusting the value that was written: a column the
    // mapper does not select is dropped silently, and the only place that
    // shows is the next read.
    expect(readWatchedRepos(sqlite)).toEqual([
      { repo: 'acme/widgets', requireLabel: 'aalai', policy: 'plan_gate' },
    ])
  })

  test('a policy this build does not know falls back rather than leaking out', () => {
    const { sqlite } = openDb(join(dir, 'aalai.sqlite'))
    writeWatchedRepos(sqlite, [{ repo: 'acme/widgets' }])
    // What a newer build writing an unknown policy would leave behind.
    sqlite
      .query('UPDATE watched_repos SET policy = ? WHERE repo = ?')
      .run('from_the_future', 'acme/widgets')

    expect(readWatchedRepos(sqlite)).toEqual([{ repo: 'acme/widgets' }])
  })

  test('a failing write leaves the previous set intact', () => {
    const { sqlite } = openDb(join(dir, 'aalai.sqlite'))
    writeWatchedRepos(sqlite, [{ repo: 'acme/widgets' }])

    // A value the column rejects, so the insert fails after the delete has run.
    expect(() =>
      writeWatchedRepos(sqlite, [
        { repo: 'acme/other', requireLabel: {} as unknown as string },
      ]),
    ).toThrow()

    expect(readWatchedRepos(sqlite)).toEqual([{ repo: 'acme/widgets' }])
  })
})

describe('importing an existing config file', () => {
  function writeConfigFile(contents: object): string {
    const path = join(dir, 'aalai.config.json')
    writeFileSync(path, JSON.stringify(contents, null, 2))
    return path
  }

  test('its values arrive in settings and the file is renamed, not deleted', async () => {
    const path = writeConfigFile({
      pollSeconds: 45,
      watch: [{ repo: 'acme/widgets' }],
      commitName: 'somebody',
    })

    const config = await loadConfig()

    expect(config.pollSeconds).toBe(45)
    expect(config.commitName).toBe('somebody')
    expect(config.watch).toEqual([{ repo: 'acme/widgets' }])
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.imported`)).toBe(true)
  })

  test('it happens once, so editing the renamed file cannot undo the app', async () => {
    writeConfigFile({ pollSeconds: 45 })
    await loadConfig()

    // A second file appearing later must not overwrite what is now in settings.
    writeConfigFile({ pollSeconds: 999 })
    const config = await loadConfig()

    expect(config.pollSeconds).toBe(45)
  })

  test('AALAI_CONFIG stays an override and leaves settings alone', async () => {
    const path = join(dir, 'explicit.json')
    writeFileSync(path, JSON.stringify({ pollSeconds: 77 }))
    process.env.AALAI_CONFIG = path

    const config = await loadConfig()
    expect(config.pollSeconds).toBe(77)

    delete process.env.AALAI_CONFIG
    const { sqlite } = openDb(join(dir, 'aalai.sqlite'))
    expect(settingsAreEmpty(sqlite)).toBe(true)
  })
})
