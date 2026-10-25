import { mkdirSync } from 'node:fs'
import { buildApp } from './app'
import { openDb } from './db'

mkdirSync('data', { recursive: true })
const db = openDb(process.env.DB_PATH ?? 'data/maptutor.db')
await buildApp(db, process.stdout).listen({ host: '127.0.0.1', port: 3001 })
