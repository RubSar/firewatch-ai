import { loadConfig } from './config.ts'
import { buildServer } from './server.ts'

const cfg = loadConfig()
const app = await buildServer(cfg)

await app.listen({ port: cfg.port, host: cfg.host })
const url = `http://${cfg.host}:${cfg.port}`
console.log(`firewatch api  ${url}  mode=${cfg.mode}  tick=${cfg.tickMs}ms`)
console.log(`  GET  ${url}/api/health`)
console.log(`  GET  ${url}/api/scenarios`)
console.log(`  POST ${url}/api/incidents           {"scenarioId":"khosrov"}`)
console.log(`  WS   ${url.replace('http', 'ws')}/api/incidents/:id/stream`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().then(() => process.exit(0))
  })
}
