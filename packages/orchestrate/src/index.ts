import { buildApp } from './app.js'

const port = Number(process.env.ORCHESTRATE_PORT ?? 8787)
const databasePath = process.env.ORCHESTRATE_DB_PATH ?? ':memory:'

const { app } = buildApp({ databasePath })

app.listen(port, () => {
  console.log(`Orchestrate listening on http://localhost:${port}`)
})
