import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/modules/db/schema/schema.ts',
  out: './src/modules/db/migrations',
})
