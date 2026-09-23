import { afterEach, describe, expect, test } from 'bun:test'
import { captureInheritedTokens, githubEnv, resetCapturedTokens } from '@/lib/credentials'

const SAVED = { ...process.env }

afterEach(() => {
  process.env = { ...SAVED }
  resetCapturedTokens()
})

describe('captureInheritedTokens', () => {
  test('removes GitHub tokens so an agent child process cannot inherit them', () => {
    process.env.GH_TOKEN = 'gho_example'
    process.env.GITHUB_TOKEN = 'ghp_example'
    const captured = captureInheritedTokens()
    expect(captured).toContain('GH_TOKEN')
    expect(captured).toContain('GITHUB_TOKEN')
    expect(process.env.GH_TOKEN).toBeUndefined()
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
  })

  test('is a no-op when nothing is set', () => {
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_ENTERPRISE_TOKEN
    delete process.env.GITHUB_ENTERPRISE_TOKEN
    expect(captureInheritedTokens()).toEqual([])
  })

  test('leaves unrelated variables alone', () => {
    process.env.PATH = '/usr/bin'
    captureInheritedTokens()
    expect(process.env.PATH).toBe('/usr/bin')
  })
})

describe('githubEnv', () => {
  test("hands the captured tokens back, so aalai's own gh commands still authenticate", () => {
    process.env.GH_TOKEN = 'gho_example'
    captureInheritedTokens()
    expect(process.env.GH_TOKEN).toBeUndefined()
    expect(githubEnv().GH_TOKEN).toBe('gho_example')
  })

  test('is empty when nothing was captured', () => {
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_ENTERPRISE_TOKEN
    delete process.env.GITHUB_ENTERPRISE_TOKEN
    captureInheritedTokens()
    expect(githubEnv()).toEqual({})
  })
})
