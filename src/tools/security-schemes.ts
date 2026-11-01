import type { ListToolsResult, McpServer } from '@modelcontextprotocol/server';

type ListToolsHandler = (request: unknown, ctx: unknown) => Promise<ListToolsResult>;

/**
 * Adds `securitySchemes` to every tool in `tools/list`, as OpenAI's Apps SDK asks
 * ("Describe each tool's auth policy with `securitySchemes`"), at the top level of the tool
 * descriptor. The SDK builds descriptors from a fixed field list, so its own handler is
 * wrapped. Call after every tool is registered. tests/remote-mcp.test.ts fails if an SDK
 * update breaks this.
 */
export function declareOAuthSecuritySchemes(
  server: McpServer,
  scopesForTool: (name: string) => readonly string[],
): void {
  const protocol = server.server as unknown as {
    _getRequestHandler?: (method: string) => ListToolsHandler | undefined;
  };
  const original = protocol._getRequestHandler?.('tools/list');
  if (!original) throw new Error('the SDK tools/list handler was not found');
  server.server.removeRequestHandler('tools/list');
  server.server.setRequestHandler('tools/list', async (request, ctx) => {
    const result = await original(request, ctx);
    return {
      ...result,
      tools: result.tools.map((tool) => ({
        ...tool,
        securitySchemes: [{ type: 'oauth2', scopes: [...scopesForTool(tool.name)] }],
      })),
    };
  });
}
