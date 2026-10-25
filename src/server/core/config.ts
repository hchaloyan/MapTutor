import { resolve } from 'node:path'

export const TUTOR_MODEL = process.env.TUTOR_MODEL ?? 'claude-opus-5-5'
export const SIDE_MODEL = process.env.SIDE_MODEL ?? 'claude-haiku-5-5'

// The Agent SDK runs in an empty working directory with its own config home, so nothing from ~/.claude reaches the tutor.
export const AGENT_DIR = resolve('data/agent')
export const CLAUDE_HOME = resolve('data/claude')
export const MAX_TURNS = 20 // model calls per hop

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // API limit per image
// 32 MB request limit after base64 (4/3), with headroom for the prompt and thread.
// ponytail: byte proxy for the token budget; count tokens if PDFs with many pages hit the 600-page or context limit
export const MAX_PROJECT_BYTES = 20 * 1024 * 1024
