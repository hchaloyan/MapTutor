import { readFileSync } from 'node:fs'

const read = (name: string) => readFileSync(new URL(`../../prompts/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

let cached: string | undefined

/** The fixed system prompt: the teaching skill verbatim (minus frontmatter) plus the app appendix. Never varies. */
export function systemPrompt(): string {
  cached ??= `${read('teaching-skill.md').replace(/^---\n[\s\S]*?\n---\n+/, '').trim()}\n\n${read('app-appendix.md').trim()}`
  return cached
}
