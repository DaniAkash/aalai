/**
 * A title for a brief, derived rather than asked for.
 *
 * Asking for a title before the description is a form that makes a person
 * name a thing they have not described yet. The first sentence is what they
 * would have written anyway, and the whole brief is kept as the body, so
 * nothing is lost by guessing badly.
 */

const LIMIT = 72

export function titleFromBrief(brief: string): string {
  const firstLine = brief.trim().split('\n')[0]?.trim() ?? ''
  if (firstLine === '') {
    return 'Untitled work'
  }
  const sentence = upToSentenceEnd(firstLine)
  return sentence.length <= LIMIT ? sentence : truncateOnAWord(sentence)
}

/** The first sentence, when the line holds more than one. */
function upToSentenceEnd(line: string): string {
  for (let at = 0; at < line.length; at += 1) {
    const char = line.charAt(at)
    if (char !== '.' && char !== '?' && char !== '!') {
      continue
    }
    // A full stop inside a word is a file name or a version, not an ending.
    const next = line.charAt(at + 1)
    if (next === '' || next === ' ') {
      return line.slice(0, at + 1)
    }
  }
  return line
}

/**
 * Cut at a word, with an ellipsis, rather than mid word.
 *
 * A title ending "formatBytes is off by o" reads as a bug in this app rather
 * than as a long title.
 */
function truncateOnAWord(sentence: string): string {
  const cut = sentence.slice(0, LIMIT)
  const lastSpace = cut.lastIndexOf(' ')
  const kept = lastSpace > LIMIT / 2 ? cut.slice(0, lastSpace) : cut
  return `${kept.replace(/[,;:.\s]+$/, '')}...`
}
