import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { displayMath, Markdown } from './Markdown'

const render = (text: string, inline = false) => renderToStaticMarkup(createElement(Markdown, { text, inline }))

test('a line holding only $$…$$ becomes display math; inline $$ inside text stays', () => {
  expect(displayMath("Rate:\n\n$$f'(a) = \lim_{h \to 0} h$$\n\nNext")).toBe("Rate:\n\n$$\nf'(a) = \lim_{h \to 0} h\n$$\n\nNext")
  expect(displayMath('so $$x$$ inline')).toBe('so $$x$$ inline')
})

test('\\$ inside math is a dollar sign, not the end of the math', () => {
  for (const tex of ['\\varepsilon, \\$ \\to \\varepsilon', '\\$', 'b, \\$ \\to \\$']) {
    const html = render(`pop $${tex}$ now`, true)
    expect(html).not.toContain('katex-error')
    expect(html).toContain(`<annotation encoding="application/x-tex">${tex}</annotation>`)
  }
  expect(render('$$\n\\$ + \\$\n$$')).toContain('<annotation encoding="application/x-tex">\\$ + \\$</annotation>')
})

test('\\$ outside math stays a literal dollar; code keeps its backslash', () => {
  expect(render('costs \\$5 or \\$6')).toContain('costs $5 or $6')
  expect(render('run `echo \\$HOME`')).toContain('<code>echo \\$HOME</code>')
  expect(render('a \\\\$x$')).toContain('<annotation encoding="application/x-tex">x</annotation>')
})
