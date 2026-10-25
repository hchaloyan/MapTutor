import 'katex/dist/katex.min.css'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

const plugins = { remark: [remarkGfm, remarkMath], rehype: [rehypeKatex] }

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
        {inline ? text : displayMath(text)}
      </ReactMarkdown>
    </div>
  )
}
