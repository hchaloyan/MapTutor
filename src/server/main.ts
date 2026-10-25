import { mkdirSync } from 'node:fs'
import { buildApp } from './app'
import { AGENT_DIR, CLAUDE_HOME } from './core/config'
import { openDb } from './core/db'
import { fakeTutor } from './tutor/fake'

// --fake swaps every Claude call for a scripted tutor, so the frontend can be built and tried for free.
const fake = process.argv.includes('--fake')
if (!fake && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error(
    'MapTutor uses your Claude subscription. Run `claude setup-token`, set CLAUDE_CODE_OAUTH_TOKEN to the token it prints (PowerShell: setx CLAUDE_CODE_OAUTH_TOKEN "<token>"), open a new terminal, and start the server again.',
  )
  process.exit(1)
}
for (const dir of ['data', AGENT_DIR, CLAUDE_HOME]) mkdirSync(dir, { recursive: true })
const db = openDb(process.env.DB_PATH ?? (fake ? 'data/maptutor-fake.db' : 'data/maptutor.db'))
const app = buildApp({ db, logStream: process.stdout, ...(fake ? fakeTutor({ delayMs: 1200 }) : {}) })
if (fake) console.log('Fake tutor: no Claude calls are made.')
await app.listen({ host: '127.0.0.1', port: 3001 })
