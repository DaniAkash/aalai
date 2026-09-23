import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { logger } from '@/lib/log'
import { exec } from '@/lib/proc'

const log = logger('service')

const LABEL = 'com.daniakash.aalai'
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const logDir = join(homedir(), '.aalai', 'logs')

/**
 * launchd owns the process, not a shell.
 *
 * `KeepAlive` restarts aalai if it dies, and the absence of `RunAtLoad` scheduling
 * quirks means the tick cadence stays inside the service itself. The Mac sleeping
 * is the real 24x7 constraint, and launchd will not wake it: pair this with
 * `caffeinate` or a pmset policy if the factory must run overnight.
 */
/** Escapes the five XML predefined entities, so a path containing `&` cannot produce an invalid plist. */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildPlist(bunPath: string, projectDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(bunPath)}</string>
    <string>run</string>
    <string>${xml(join(projectDir, 'src', 'index.ts'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, 'aalai.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, 'aalai.err.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${join(homedir(), '.bun', 'bin')}`)}</string>
  </dict>
</dict>
</plist>
`
}

async function install(): Promise<void> {
  const bunPath = process.execPath
  const projectDir = resolve(import.meta.dir, '..')
  mkdirSync(logDir, { recursive: true })
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  await Bun.write(plistPath, buildPlist(bunPath, projectDir))

  await exec(['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}/${LABEL}`])
  const result = await exec([
    'launchctl',
    'bootstrap',
    `gui/${process.getuid?.() ?? 501}`,
    plistPath,
  ])
  if (result.exitCode !== 0) {
    log.error('launchctl bootstrap failed', { stderr: result.stderr.trim() })
    process.exitCode = 1
    return
  }
  log.info('installed', { plist: plistPath, logs: logDir })
}

async function uninstall(): Promise<void> {
  await exec(['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}/${LABEL}`])
  await exec(['rm', '-f', plistPath])
  log.info('uninstalled', { plist: plistPath })
}

async function status(): Promise<void> {
  const result = await exec(['launchctl', 'list', LABEL])
  if (result.exitCode !== 0) {
    log.info('not installed')
    return
  }
  log.info('installed and registered')
  console.log(result.stdout.trim())
}

const command = process.argv[2] ?? 'status'
if (command === 'install') {
  await install()
} else if (command === 'uninstall') {
  await uninstall()
} else if (command === 'status') {
  await status()
} else {
  log.error('usage: bun run service <install|uninstall|status>')
  process.exitCode = 1
}
