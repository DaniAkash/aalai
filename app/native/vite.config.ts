import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { homedir } from 'node:os'
import { defineConfig, searchForWorkspaceRoot } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))

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
