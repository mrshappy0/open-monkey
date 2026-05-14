#!/usr/bin/env node
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
const CONNECT_WAIT_MS = 25_000;
const CONNECT_POLL_MS = 500;
// ---------------------------------------------------------------------------
// WebSocket bridge — the extension connects here
// ---------------------------------------------------------------------------
let extensionSocket = null;
const pending = new Map();
async function createWss(maxRetries = 4, delayMs = 1500) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const w = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
                w.once('listening', () => resolve(w));
                w.once('error', reject);
            });
        }
        catch (err) {
            const e = err;
            if (e.code === 'EADDRINUSE' && attempt < maxRetries) {
                console.error(`[OpenMonkey] Port ${WS_PORT} in use — retrying in ${delayMs}ms (${attempt + 1}/${maxRetries})…`);
                await new Promise(r => setTimeout(r, delayMs));
            }
            else {
                throw err;
            }
        }
    }
    throw new Error('unreachable');
}
const wss = await createWss();
console.error(`[OpenMonkey] Bridge listening on ws://127.0.0.1:${WS_PORT}`);
wss.on('error', (err) => console.error('[OpenMonkey] WSS error:', err));
wss.on('connection', (socket) => {
    console.error('[OpenMonkey] Extension connected');
    extensionSocket = socket;
    socket.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            const handler = pending.get(msg.id);
            if (!handler)
                return;
            pending.delete(msg.id);
            if (msg.error)
                handler.reject(new Error(msg.error));
            else
                handler.resolve(msg.result);
        }
        catch {
            // ignore malformed messages
        }
    });
    socket.on('close', () => {
        if (extensionSocket === socket)
            extensionSocket = null;
        console.error('[OpenMonkey] Extension disconnected');
    });
});
/**
 * Send a command to the extension and wait for its response.
 * If the extension is not yet connected, waits up to CONNECT_WAIT_MS for it
 * to wake up (the service worker keep-alive alarm fires every ~20s).
 */
function send(type, payload) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + CONNECT_WAIT_MS;
        function attempt() {
            if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
                const id = crypto.randomUUID();
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`Request "${type}" timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
                }, REQUEST_TIMEOUT_MS);
                pending.set(id, {
                    resolve: (v) => { clearTimeout(timer); resolve(v); },
                    reject: (e) => { clearTimeout(timer); reject(e); },
                });
                extensionSocket.send(JSON.stringify({ id, type, payload }));
            }
            else if (Date.now() < deadline) {
                setTimeout(attempt, CONNECT_POLL_MS);
            }
            else {
                reject(new Error('OpenMonkey extension is not connected. ' +
                    'Make sure the extension is loaded and active in Chrome, ' +
                    'then navigate to any page to wake the service worker.'));
            }
        }
        attempt();
    });
}
// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const server = new McpServer({
    name: 'openmonkey',
    version: '1.0.0',
});
server.registerTool('list_scripts', { description: 'List all userscripts managed by OpenMonkey, including their IDs, names, and enabled state.' }, async () => {
    const scripts = await send('list_scripts');
    return { content: [{ type: 'text', text: JSON.stringify(scripts, null, 2) }] };
});
server.registerTool('get_script', {
    description: 'Get the full source code of a userscript by its ID. Use list_scripts first to find the ID.',
    inputSchema: { id: z.string().describe('Script ID returned by list_scripts') },
}, async ({ id }) => {
    const script = await send('get_script', { id });
    return { content: [{ type: 'text', text: JSON.stringify(script, null, 2) }] };
});
server.registerTool('create_script', {
    description: 'Create a new userscript in OpenMonkey. The code must include a valid ==UserScript== header with at least @name and one @match directive.',
    inputSchema: { code: z.string().describe('Full userscript source including the ==UserScript== header block') },
}, async ({ code }) => {
    const script = await send('create_script', { code });
    return { content: [{ type: 'text', text: JSON.stringify(script, null, 2) }] };
});
server.registerTool('update_script', {
    description: 'Replace the source of an existing userscript by its ID. Use list_scripts first to find the ID.',
    inputSchema: {
        id: z.string().describe('Script ID returned by list_scripts'),
        code: z.string().describe('Updated userscript source including the ==UserScript== header block'),
    },
}, async ({ id, code }) => {
    const script = await send('update_script', { id, code });
    return { content: [{ type: 'text', text: JSON.stringify(script, null, 2) }] };
});
server.registerTool('delete_script', {
    description: 'Permanently delete a userscript by its ID.',
    inputSchema: { id: z.string().describe('Script ID returned by list_scripts') },
}, async ({ id }) => {
    await send('delete_script', { id });
    return { content: [{ type: 'text', text: `Script "${id}" deleted.` }] };
});
server.registerTool('get_active_tab', { description: 'Get the URL and title of the currently active Chrome tab.' }, async () => {
    const tab = await send('get_active_tab');
    return { content: [{ type: 'text', text: JSON.stringify(tab, null, 2) }] };
});
server.registerTool('get_page_content', { description: 'Get the full visible text content of the currently active Chrome tab. Useful for reading page context before writing a script.' }, async () => {
    const text = await send('get_page_content');
    return { content: [{ type: 'text', text }] };
});
server.registerTool('execute_script', {
    description: 'Execute a JavaScript expression or statement block in the currently active Chrome tab and return the result. Use for DOM inspection, testing selectors, or quick checks.',
    inputSchema: { code: z.string().describe('JavaScript to execute in the page context. The return value of the last expression is captured.') },
}, async ({ code }) => {
    const result = await send('execute_script', { code });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});
// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
