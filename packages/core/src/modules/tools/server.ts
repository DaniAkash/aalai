import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { ToolContext } from './context'
import { registerStationTools } from './registry'

/**
 * One MCP server per request, scoped to the run the token named.
 *
 * Stateless because the alternative buys nothing here: the tool set is derived
 * entirely from the token in the url, so there is no session state worth
 * keeping between an agent's `tools/list` and its `tools/call`, and a server
 * held open per run is a lifecycle to get wrong when a run dies badly.
 */
export async function handleToolRequest(
  request: Request,
  context: ToolContext,
): Promise<Response> {
  const server = new McpServer(
    { name: 'aalai', version: '1' },
    {
      instructions:
        'Record what you decide by calling these tools. Anything you record is versioned and kept; anything you only write as prose is not.',
    },
  )
  registerStationTools(server, context)

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    await transport.close()
  }
}
