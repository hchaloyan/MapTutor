import { expect, test } from 'vitest'
import { matchRoute } from './router'

test('routes match projects and goals', () => {
  expect(matchRoute('/')).toEqual({ name: 'projects', projectId: null })
  expect(matchRoute('/projects/p1')).toEqual({ name: 'projects', projectId: 'p1' })
  expect(matchRoute('/goals/g1')).toEqual({ name: 'goal', goalId: 'g1' })
  expect(matchRoute('/nope/x')).toEqual({ name: 'projects', projectId: null })
})
