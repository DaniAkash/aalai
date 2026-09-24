import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, searchForWorkspaceRoot } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Where the factory is, for the web build.
 *
 * The desktop build asks the shell, which knows the port it handed the sidecar.
 * A browser has nobody to ask, so it uses the configured port the factory
 * listens on by default and lets an env var override it.
 */
const API_TARGET = process.env.AALAI_API_URL ?? 'http://127.0.0.1:4173'
const API_TOKEN = process.env.AALAI_API_TOKEN

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { '@': path.resolve(here, './src') } },
  // Tauri expects a fixed port and surfaces rust errors rather than hiding them.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      /**
       * The factory, reached same origin.
       *
       * Without this the page would be calling 127.0.0.1 from localhost, which
       * is cross origin, so a server that can open pull requests would have to
       * send CORS headers to a browser. Proxying keeps that surface shut.
       *
       * The proxy is also where a token belongs when one is set. It runs in
       * node, not in the page, so the secret stays out of the browser exactly
       * as it stays out of the webview in the desktop build.
       */
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // Server sent events must not be buffered, or the live stream arrives
        // in one lump when the connection finally closes.
        ws: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => {
            if (API_TOKEN !== undefined) {
              request.setHeader('authorization', `Bearer ${API_TOKEN}`)
            }
          })
        },
      },
    },
    fs: {
      // The isolated linker keeps packages in bun's global store rather than
      // inside the project, so font files resolve to paths outside the root
      // and Vite refuses to serve them. Allowing the store is what makes the
      // shared install work in dev; without it the app renders in fallback
      // fonts and the console fills with denials.
      allow: [
        searchForWorkspaceRoot(here),
        path.join(homedir(), '.bun', 'install', 'cache'),
      ],
    },
  },
})
