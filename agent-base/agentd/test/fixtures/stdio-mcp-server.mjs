// Minimal stdio MCP server for the bridge's stdio tests (#1676): one tool
// that reports the env var and cwd it was spawned with, so the test can pin
// the env/cwd contract, and one that returns an image block.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'stdio-fixture', version: '1.0' })
server.tool('whereami', 'Report spawn env and cwd', {}, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ marker: process.env.FIXTURE_MARKER ?? null, cwd: process.cwd(), argv: process.argv.slice(2) }) }],
}))
server.tool('snap', 'Return a 1x1 PNG', {}, async () => ({
  content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
}))
await server.connect(new StdioServerTransport())
