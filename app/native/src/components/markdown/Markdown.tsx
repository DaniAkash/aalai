import { splitRichText } from 'aalai/shared'
import { AgentCode } from '@/components/agents/agent-code'
import { cn } from '@/lib/utils'
import { languageFor, renderProse } from './markdown.helpers'

/**
 * Markdown somebody else wrote, rendered.
 *
 * The only place in the app that inserts html, and it only ever inserts prose
 * that `renderProse` has sanitised. Code is split out before any of that
 * happens and goes to the highlighter as text, so a fence cannot carry markup
 * into the page no matter what is inside it.
 *
 * The prose styling lives here as a class list rather than in a stylesheet,
 * because the sanitiser strips class attributes and the elements arrive bare.
 */
export function Markdown({
  body,
  className,
}: {
  body: string
  className?: string
}) {
  const segments = splitRichText(body)
  if (segments.length === 0) {
    return null
  }
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {segments.map((segment) =>
        segment.kind === 'code' ? (
          <AgentCode
            // Keyed on where it starts, not on its text: two identical fences
            // in one body are two different blocks.
            key={`code-${segment.offset}`}
            code={segment.text}
            language={languageFor(segment.language)}
            className="max-h-[420px] overflow-auto text-[12px]"
          />
        ) : (
          <Prose key={`prose-${segment.offset}`} markdown={segment.text} />
        ),
      )}
    </div>
  )
}

/**
 * One run of prose.
 *
 * `dangerouslySetInnerHTML` appears here and nowhere else in this app. What it
 * is given has been through the sanitiser in `renderProse`, which is the only
 * function that produces html, so there is one pair of places to read rather
 * than a rule to remember at every call site.
 */
function Prose({ markdown }: { markdown: string }) {
  return (
    <div
      className={PROSE}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the one inlet for html in this app, and the only caller of the only function that produces any. renderProse sanitises against an explicit allowlist, and fenced code is split out before this so it never takes this path.
      dangerouslySetInnerHTML={{ __html: renderProse(markdown) }}
    />
  )
}

/**
 * How bare elements look, since the sanitiser removes every class.
 *
 * Arbitrary variants rather than a typography plugin: this is the only prose
 * in the app, and a plugin would bring a type scale that disagrees with the
 * one the rest of these screens already use.
 */
const PROSE = cn(
  'text-[13px] leading-relaxed',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_p]:my-2',
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:font-semibold [&_h1]:text-[15px]',
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:font-semibold [&_h2]:text-[14px]',
  '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:font-semibold [&_h3]:text-[13.5px]',
  '[&_h4]:mt-3 [&_h4]:mb-1.5 [&_h4]:font-semibold [&_h4]:text-[13px]',
  '[&_h5]:mt-3 [&_h5]:mb-1.5 [&_h5]:font-semibold [&_h5]:text-[13px]',
  '[&_h6]:mt-3 [&_h6]:mb-1.5 [&_h6]:font-semibold [&_h6]:text-[13px]',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5',
  '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-0.5',
  '[&_strong]:font-semibold',
  '[&_em]:italic',
  '[&_del]:line-through [&_del]:text-muted-foreground',
  '[&_a]:underline [&_a]:underline-offset-2 [&_a]:text-foreground',
  '[&_hr]:my-4 [&_hr]:border-border',
  '[&_blockquote]:my-2 [&_blockquote]:border-border [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11.5px]',
  '[&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-[calc(var(--radius)-2px)] [&_pre]:border [&_pre]:border-border [&_pre]:bg-card [&_pre]:p-3',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_table]:my-2 [&_table]:block [&_table]:w-full [&_table]:overflow-auto [&_table]:border-collapse',
  '[&_th]:border [&_th]:border-border [&_th]:bg-secondary/40 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-[12px]',
  '[&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:text-[12.5px]',
)
