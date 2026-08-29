import { drizzle } from 'drizzle-orm/expo-sqlite'
import { bundledExtensions, openDatabaseSync } from 'expo-sqlite'

import * as schema from './schema'

//deleteDatabaseAsync('db.db')
export const sqliteDB = openDatabaseSync('db.db', { enableChangeListener: true })
const extension = bundledExtensions['sqlite-vec']
if (extension) sqliteDB.loadExtensionAsync(extension?.libPath, extension?.entryPoint)
export const db = drizzle(sqliteDB, { schema })

export type TableNames = {
    [K in keyof typeof schema]: (typeof schema)[K] extends { _: { name: infer TName } }
        ? TName & string
        : never
}[keyof typeof schema]

sqliteDB.execAsync('PRAGMA foreign_keys = ON;')

// Schema migrations (including v2 attachment columns sha256/width/height) are
// applied by useMigrations(db, migrations) in app/index.tsx using the drizzle
// journal (db/migrations/migrations.js, m0000–m0021). No hand-rolled ALTER
// IIFE needed — that approach raced the migrator and was invisible to fresh
// installs' journal.
