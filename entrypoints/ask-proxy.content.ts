/**
 * ask-proxy — content script bridge between the USER_SCRIPT world and background.
 *
 * The ask-page userscript cannot make cross-origin fetches (CORS). This content
 * script runs in the extension context and relays API requests to background.ts
 * via a chrome.runtime port, which CAN make cross-origin requests freely.
 *
 * Events in:  om-ask-request { id, endpoint, apiKey, model, messages }
 *             om-ask-abort   { id }
 * Events out: om-ask-token   { id, content }
 *             om-ask-done    { id }
 *             om-ask-error   { id, message }
 */

interface AskRequestDetail {
  id: string;
  endpoint: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
}

interface PortMessage {
  type: 'token' | 'done' | 'error';
  content?: string;
  message?: string;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',

  main() {
    window.addEventListener('om-ask-request', (e: Event) => {
      const detail = (e as CustomEvent<AskRequestDetail>).detail;
      const { id, endpoint, apiKey, model, messages } = detail;

      const port = browser.runtime.connect({ name: 'ask-proxy' });
      port.postMessage({ type: 'request', id, endpoint, apiKey, model, messages });

      port.onMessage.addListener((msg: PortMessage) => {
        if (msg.type === 'token') {
          window.dispatchEvent(new CustomEvent('om-ask-token', { detail: { id, content: msg.content } }));
        } else if (msg.type === 'done') {
          window.dispatchEvent(new CustomEvent('om-ask-done', { detail: { id } }));
          port.disconnect();
        } else if (msg.type === 'error') {
          window.dispatchEvent(new CustomEvent('om-ask-error', { detail: { id, message: msg.message } }));
          port.disconnect();
        }
      });

      function onAbort(ae: Event) {
        if ((ae as CustomEvent<{ id: string }>).detail.id !== id) return;
        port.postMessage({ type: 'abort' });
        window.removeEventListener('om-ask-abort', onAbort);
      }
      window.addEventListener('om-ask-abort', onAbort);

      port.onDisconnect.addListener(() => {
        window.removeEventListener('om-ask-abort', onAbort);
      });
    });
  },
});
