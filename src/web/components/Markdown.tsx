import 'katex/dist/katex.min.css'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

/** remark-math ends math at any `$`, even TeX's `\$`. Hide `\$` from the parser (pairing `\\` first), then put it back. */
const DOLLAR = ''
const hideDollars = (text: string) => text.replace(/\\[\\$]/g, m => (m === '\\$' ? DOLLAR : m))
type Node = { tagName?: string; value?: unknown; children?: Node[] }
const restoreDollars = () => {
  // Math and code render as <code>, where `\$` is raw; elsewhere it was a Markdown escape.
  const walk = (node: Node, raw: boolean) => {
    if (typeof node.value === 'string') node.value = node.value.replaceAll(DOLLAR, raw ? '\\$' : '$')
    node.children?.forEach(child => walk(child, raw || node.tagName === 'code'))
  }
  return (tree: Node) => walk(tree, false)
}

const plugins = { remark: [remarkGfm, remarkMath], rehype: [restoreDollars, rehypeKatex] }

/** remark-math treats `$$…$$` on one line as inline math; a line holding only that is meant as display math. */
export const displayMath = (text: string) => text.replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_m, tex: string) => `$$\n${tex}\n$$`)

/** Tutor text: Markdown, GFM tables, and KaTeX math ($…$ inline, $$…$$ display). */
export function Markdown({ text, inline = false }: { text: string; inline?: boolean }) {
  return (
    <div className={inline ? 'md md-inline' : 'md'}>
      <ReactMarkdown
        remarkPlugins={plugins.remark}
        rehypePlugins={plugins.rehype}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {inline ? hideDollars(text) : displayMath(hideDollars(text))}
      </ReactMarkdown>
    </div>
  )
}
