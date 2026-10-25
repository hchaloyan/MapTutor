import { expect, test } from 'vitest'
import { resolveTheme } from './theme'

test('the theme follows the OS until the user picks one', () => {
  expect(resolveTheme(null, false)).toBe('light')
  expect(resolveTheme(null, true)).toBe('dark')
  expect(resolveTheme('light', true)).toBe('light')
  expect(resolveTheme('dark', false)).toBe('dark')
  expect(resolveTheme('nonsense', true)).toBe('dark')
})
