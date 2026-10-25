import { expect, test } from 'vitest'
import { displayMath } from './Markdown'

test('a line holding only $$…$$ becomes display math; inline $$ inside text stays', () => {
  expect(displayMath("Rate:\n\n$$f'(a) = \lim_{h \to 0} h$$\n\nNext")).toBe("Rate:\n\n$$\nf'(a) = \lim_{h \to 0} h\n$$\n\nNext")
  expect(displayMath('so $$x$$ inline')).toBe('so $$x$$ inline')
})
