import { afterEach, describe, expect, test } from 'bun:test'
import { scrubInheritedTokens } from '@/lib/credentials'

const SAVED = { ...process.env }

afterEach(() => {
  process.env = { ...SAVED }
})

describe('scrubInheritedTokens', () => {
  test('removes GitHub tokens so an agent child process cannot inherit them', () => {
    process.env.GH_TOKEN = 'gho_example'
    process.env.GITHUB_TOKEN = 'ghp_example'
    const removed = scrubInheritedTokens()
    expect(removed).toContain('GH_TOKEN')
    expect(removed).toContain('GITHUB_TOKEN')
    expect(process.env.GH_TOKEN).toBeUndefined()
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
  })

  test('is a no-op when nothing is set', () => {
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_ENTERPRISE_TOKEN
    delete process.env.GITHUB_ENTERPRISE_TOKEN
    expect(scrubInheritedTokens()).toEqual([])
  })

  test('leaves unrelated variables alone', () => {
    process.env.PATH = '/usr/bin'
    scrubInheritedTokens()
    expect(process.env.PATH).toBe('/usr/bin')
  })
})
