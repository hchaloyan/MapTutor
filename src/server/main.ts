import { mkdirSync } from 'node:fs'
import { buildApp } from './app'
import { openDb } from './core/db'
import { fakeTutor } from './tutor/fake'

// --fake swaps every Claude call for a scripted tutor, so the frontend can be built and tried for free.
const fake = process.argv.includes('--fake')
mkdirSync('data', { recursive: true })
const db = openDb(process.env.DB_PATH ?? (fake ? 'data/maptutor-fake.db' : 'data/maptutor.db'))
const app = buildApp({ db, logStream: process.stdout, ...(fake ? fakeTutor({ delayMs: 1200 }) : {}) })
if (fake) console.log('Fake tutor: no Claude calls are made.')
await app.listen({ host: '127.0.0.1', port: 3001 })
