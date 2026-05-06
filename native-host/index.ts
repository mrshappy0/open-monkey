/**
 * OpenMonkey MCP Native Host
 *
 * Runs as an MCP stdio server (Copilot connects here) and simultaneously
 * hosts a WebSocket server on localhost:7331 that the browser extension
 * connects to. Tool calls from Copilot are forwarded over the WebSocket
 * to the extension, which executes them and sends back results.
 *
 * Usage in .vscode/mcp.json:
 * {
 *   "servers": {
 *     "openmonkey": {
 *       "type": "stdio",
 *       "command": "npx",
 *       "args": ["tsx", "${workspaceFolder}/native-host/index.ts"]
 *     }
 *   }
 * }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';

const WS_PORT = 7331;
const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// WebSocket bridge — the extension connects here
// ---------------------------------------------------------------------------

let extensionSocket: WebSocket | null = null;
const pending = new Map<string, {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}>();

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

wss.on('listening', () => {
  console.error(`[OpenMonkey] Bridge listening on ws://127.0.0.1:${WS_PORT}`);
});

wss.on('connection', (socket) => {
  console.error('[OpenMonkey] Extension connected');
  extensionSocket = socket;

  socket.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as {
        id: string;
        result?: unknown;
        error?: string;
      };
      const handler = pending.get(msg.id);
      if (!handler) return;
      pending.delete(msg.id);
      if (msg.error) handler.reject(new Error(msg.error));
      else handler.resolve(msg.result);
    } catch {
      // ignore malformed messages
    }
  });

  socket.on('close', () => {
    if (extensionSocket === socket) extensionSocket = null;
    console.error('[OpenMonkey] Extension disconnected');
  });
});

/**
 * Send a command to the extension and wait for its response.
 * Rejects if the extension is not connected or if the request times out.
 */
function send<T>(type: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      reject(new Error(
        'OpenMonkey extension is not connected. ' +
        'Make sure the extension is loaded and active in Chrome, ' +
        'then navigate to any page to wake the service worker.',
      ));
      return;
    }

    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Request "${type}" timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v as T); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
    });

    extensionSocket.send(JSON.stringify({ id, type, payload }));
  });
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'openmonkey',
  version: '1.0.0',
});

server.registerTool(
  'list_scripts',
  { description: 'List all userscripts managed by OpenMonkey, including their IDs, names, and enabled state.' },
  async () => {
    const scripts = await send('list_scripts');
    return { content: [{ type: 'text' as const, text: JSON.stringify(scripts, null, 2) }] };
  },
);

server.registerTool(
  'get_script',
  {
    description: 'Get the full source code of a userscript by its ID. Use list_scripts first to find the ID.',
    inputSchema: { id: z.string().describe('Script ID returned by list_scripts') },
  },
  async ({ id }) => {
    const script = await send('get_script', { id });
    return { content: [{ type: 'text' as const, text: JSON.stringify(script, null, 2) }] };
  },
);

server.registerTool(
  'create_script',
  {
    description: 'Create a new userscript in OpenMonkey. The code must include a valid ==UserScript== header with at least @name and one @match directive.',
    inputSchema: { code: z.string().describe('Full userscript source including the ==UserScript== header block') },
  },
  async ({ code }) => {
    const script = await send('create_script', { code });
    return { content: [{ type: 'text' as const, text: JSON.stringify(script, null, 2) }] };
  },
);

server.registerTool(
  'update_script',
  {
    description: 'Replace the source of an existing userscript by its ID. Use list_scripts first to find the ID.',
    inputSchema: {
      id:   z.string().describe('Script ID returned by list_scripts'),
      code: z.string().describe('Updated userscript source including the ==UserScript== header block'),
    },
  },
  async ({ id, code }) => {
    const script = await send('update_script', { id, code });
    return { content: [{ type: 'text' as const, text: JSON.stringify(script, null, 2) }] };
  },
);

server.registerTool(
  'delete_script',
  {
    description: 'Permanently delete a userscript by its ID.',
    inputSchema: { id: z.string().describe('Script ID returned by list_scripts') },
  },
  async ({ id }) => {
    await send('delete_script', { id });
    return { content: [{ type: 'text' as const, text: `Script "${id}" deleted.` }] };
  },
);

server.registerTool(
  'get_active_tab',
  { description: 'Get the URL and title of the currently active Chrome tab.' },
  async () => {
    const tab = await send<{ url: string; title: string }>('get_active_tab');
    return { content: [{ type: 'text' as const, text: JSON.stringify(tab, null, 2) }] };
  },
);

server.registerTool(
  'get_page_content',
  { description: 'Get the full visible text content of the currently active Chrome tab. Useful for reading page context before writing a script.' },
  async () => {
    const text = await send<string>('get_page_content');
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.registerTool(
  'execute_script',
  {
    description: 'Execute a JavaScript expression or statement block in the currently active Chrome tab and return the result. Use for DOM inspection, testing selectors, or quick checks.',
    inputSchema: { code: z.string().describe('JavaScript to execute in the page context. The return value of the last expression is captured.') },
  },
  async ({ code }) => {
    const result = await send('execute_script', { code });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
