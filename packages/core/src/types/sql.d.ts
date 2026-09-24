/**
 * SQL files imported as text, which is how migrations travel inside the
 * compiled binary instead of being read from a directory at runtime.
 */
declare module '*.sql' {
  const content: string
  export default content
}
