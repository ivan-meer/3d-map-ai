/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This is the main entry point for the application.
 * It sets up the LitElement-based MapApp component, initializes the Google GenAI
 * client for chat interactions, and establishes communication between the
 * Model Context Protocol (MCP) client and server. The MCP server exposes
 * map-related tools that the AI model can use, and the client relays these
 * tool calls to the server.
 */

import {GoogleGenAI, mcpToTool} from '@google/genai';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {ChatState, MapApp, marked} from './map_app'; // Updated import path

import {startMcpGoogleMapServer, MapParams} from './mcp_maps_server';

/* --------- */

async function startClient(transport: Transport) {
  const client = new Client({name: 'AI Studio', version: '1.0.0'});
  await client.connect(transport);
  return client;
}

/* ------------ */

const SYSTEM_INSTRUCTIONS = `You are an expert cartographer, travel guide, and AI navigator. You are highly proficient with 3D maps, finding landmarks, and curating travel plans.
Your primary goal is to assist users by managing and modifying the interactive map using the available tools.

Tool Usage Guidelines:
1.  **Identify Specific Locations First:** Before using 'view_location_google_maps' or 'directions_on_google_maps', you MUST determine a specific, concrete place name, address, or well-known landmark.
    *   **GOOD:** Puerto Williams, Chile (not "southernmost town").
    *   **GOOD:** The Louvre Museum, Paris (not "interesting museum").
2.  **Clear Route Arguments:** For 'directions_on_google_maps', ensure both 'origin' and 'destination' parameters are specific, recognizable place names or addresses.
3.  **Active Map Interactions & Control:**
    *   **Live Weather Overlay:** When a user asks about local climate, weather conditions, temperature, or wants to visualize clouds/rain, use 'toggle_weather_overlay' with 'enable: true'. Disable it with 'enable: false'.
    *   **POI/Attraction Exploration:** When asked to find landmarks, parks, museums, cafes, or sights around the current area, use 'toggle_poi_markers' with 'enable: true' and optional filters.
    *   **3D Camera Adjustments:** When asked to tilt the view, rotate the map, or zoom in/out (e.g., "Look from the horizon", "Point north-east", "Zoom closer"), use 'set_map_camera' with relevant parameters (tilt: 0-90, heading: 0-360, range in meters).
    *   **Bookmarks:** If a user loves a view or wants to save a location, use 'manage_bookmarks' with 'action: "add"' and a name, or list bookmarks with 'action: "list"'.
    *   **Auto-Tours:** When the user wants to take a tour of their saved landmarks, use 'manage_tour' with 'action: "play"'.
4.  **Explain Actions and Add Fun Facts:** After initiating a map tool call, explain what you are displaying or adjusting, and share fascinating historical, scientific, or travel trivia about the destination.
5.  **ALWAYS NAVIGATE TO DISCUSSED LOCATIONS:** Whenever the user asks about, mentions, or requests information/fun facts about any specific place, island, country, city, landmark, or region (such as Hawaii, Grand Canyon, Eiffel Tower, etc.), you **MUST ALWAYS** first call the \`view_location_google_maps\` tool to transition the map camera there. Never just provide information or talk about a place without also flying the map camera to that location!`;

// Client-side fetch interceptor to guarantee SSE streams always end with a double newline (\n\n).
// This prevents the SDK from throwing "Incomplete JSON segment at the end" when proxies (like Vite or Nginx)
// buffer or strip trailing whitespace/newlines from SSE responses.
const originalFetch = window.fetch || globalThis.fetch;
const customFetch = async function (input: RequestInfo | URL, init?: RequestInit) {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

  if (url.includes('streamGenerateContent') && url.includes('alt=sse')) {
    const response = await originalFetch(input, init);
    if (!response.ok || !response.body) {
      return response;
    }

    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let lastChunkStr = '';

    const newStream = new ReadableStream({
      async pull(controller: any) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            // Check if the final chunk ends with double newline (\n\n or \r\n\r\n)
            if (
              lastChunkStr &&
              !lastChunkStr.endsWith('\n\n') &&
              !lastChunkStr.endsWith('\r\n\r\n')
            ) {
              console.log(
                '[Fetch Interceptor] Appending missing trailing double newline to stream'
              );
              const missingNewlines = lastChunkStr.endsWith('\n') ? '\n' : '\n\n';
              controller.enqueue(encoder.encode(missingNewlines));
            }
            controller.close();
            return;
          }
          lastChunkStr = decoder.decode(value, { stream: true });
          controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        reader.cancel();
      },
    });

    return new Response(newStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return originalFetch(input, init);
};

try {
  Object.defineProperty(window, 'fetch', {
    value: customFetch,
    writable: true,
    configurable: true,
    enumerable: true,
  });
} catch (e) {
  console.warn('[Fetch Interceptor] Could not define fetch on window, trying globalThis:', e);
  try {
    Object.defineProperty(globalThis, 'fetch', {
      value: customFetch,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch (err2) {
    console.error('[Fetch Interceptor] Failed to intercept fetch on both window and globalThis:', err2);
  }
}

const ai = new GoogleGenAI({
  apiKey: 'PROXY_MODE', // Keep as dummy string, actual key appended securely on server/proxy
  httpOptions: {
    baseUrl: `${window.location.origin}/api/proxy/`,
  },
});

function createAiChat(mcpClient: Client) {
  return ai.chats.create({
    model: 'gemini-3.5-flash',
    config: {
      systemInstruction: SYSTEM_INSTRUCTIONS,
      tools: [mcpToTool(mcpClient)],
    },
  });
}

function extractErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error occurred.';
  
  let baseErrorText = '';
  if (err instanceof Error) {
    baseErrorText = err.message;
  } else if (typeof err === 'string') {
    baseErrorText = err;
  } else if (
    err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as {message: unknown}).message === 'string'
  ) {
    baseErrorText = (err as {message: string}).message;
  } else {
    try {
      baseErrorText = JSON.stringify(err);
    } catch {
      baseErrorText = String(err);
    }
  }

  // Helper to parse nested stringified JSON error messages recursively (up to 5 levels)
  let currentStr = baseErrorText;
  for (let depth = 0; depth < 5; depth++) {
    const jsonStartIndex = currentStr.indexOf('{');
    const jsonEndIndex = currentStr.lastIndexOf('}');
    if (jsonStartIndex > -1 && jsonEndIndex > jsonStartIndex) {
      const potentialJson = currentStr.substring(jsonStartIndex, jsonEndIndex + 1);
      try {
        const parsed = JSON.parse(potentialJson);
        if (parsed && typeof parsed === 'object') {
          if (
            parsed.error &&
            typeof parsed.error === 'object' &&
            typeof parsed.error.message === 'string'
          ) {
            currentStr = parsed.error.message;
            continue;
          } else if (typeof parsed.message === 'string') {
            currentStr = parsed.message;
            continue;
          }
        }
      } catch {
        // Stop going deeper if JSON parse fails
        break;
      }
    }
    break;
  }
  return currentStr;
}

function camelCaseToDash(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

document.addEventListener('DOMContentLoaded', async (event) => {
  const rootElement = document.querySelector('#root')! as HTMLElement;

  const mapApp = new MapApp();
  rootElement.appendChild(mapApp);

  const [transportA, transportB] = InMemoryTransport.createLinkedPair();

  void startMcpGoogleMapServer(
    transportA,
    (params: MapParams) => {
      mapApp.handleMapQuery(params);
    },
  );

  const mcpClient = await startClient(transportB);
  const aiChat = createAiChat(mcpClient);

  mapApp.sendMessageHandler = async (input: string, role: string) => {
    console.log('sendMessageHandler', input, role);

    const apiKey = process.env.API_KEY || '';
    if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
      const {textElement} = mapApp.addMessage('error', '');
      textElement.innerHTML = await marked.parse(
        `### Gemini API Key Required\n\nTo use the Gemini AI chat assistant, please configure your **GEMINI_API_KEY**:\n\n1. Open **Settings** (⚙️ gear icon, top-right corner) → **Secrets**.\n2. Add a secret named \`GEMINI_API_KEY\` with your actual Gemini API key.\n3. Press **Enter** to save.\n\nThe app will automatically rebuild and connect after the secret is added!`
      );
      mapApp.setChatState(ChatState.IDLE);
      return;
    }

    const {thinkingElement, textElement, thinkingContainer} = mapApp.addMessage(
      'assistant',
      '',
    );

    mapApp.setChatState(ChatState.GENERATING);
    textElement.innerHTML = '...'; // Initial placeholder

    let newCode = '';
    let thoughtAccumulator = '';

    try {
      // Outer try for overall message handling including post-processing
      try {
        let currentInput: any = {message: input};

        while (true) {
          // Inner try for AI interaction and message parsing
          const stream = await aiChat.sendMessageStream(currentInput);

          for await (const chunk of stream) {
            for (const candidate of chunk.candidates ?? []) {
              for (const part of candidate.content?.parts ?? []) {
                if (part.thought) {
                  mapApp.setChatState(ChatState.THINKING);
                  thoughtAccumulator += ' ' + part.thought;
                  thinkingElement.innerHTML =
                    await marked.parse(thoughtAccumulator);
                  if (thinkingContainer) {
                    thinkingContainer.classList.remove('hidden');
                    thinkingContainer.setAttribute('open', 'true');
                  }
                } else if (part.text) {
                  mapApp.setChatState(ChatState.EXECUTING);
                  newCode += part.text;
                  textElement.innerHTML = await marked.parse(newCode);
                }
                mapApp.scrollToTheEnd();
              }
            }
          }

          // Retrieve the fully assembled and parsed function calls from the chat history
          const history = aiChat.getHistory();
          const lastMessage = history[history.length - 1];
          const functionCallsToExecute = [];
          if (
            lastMessage &&
            (lastMessage.role === 'model' || lastMessage.role === 'assistant') &&
            lastMessage.parts
          ) {
            for (const part of lastMessage.parts) {
              if (part.functionCall) {
                console.log(
                  'COMPLETED FUNCTION CALL:',
                  part.functionCall.name,
                  part.functionCall.args,
                );
                functionCallsToExecute.push(part.functionCall);
              }
            }
          }

          if (functionCallsToExecute.length === 0) {
            break; // No more function calls, exit the loop
          }

          // Add visual logs of function calls that are about to execute
          for (const fc of functionCallsToExecute) {
            const normalizedName = fc.name
              .replace(/([a-z])([A-Z])/g, '$1_$2')
              .replace(/-/g, '_')
              .toLowerCase();

            const mcpCall = {
              name: normalizedName,
              arguments: fc.args,
            };

            const explanation =
              'Calling function:\n```json\n' +
              JSON.stringify(mcpCall, null, 2) +
              '\n```';
            const {textElement: functionCallText} = mapApp.addMessage(
              'assistant',
              '',
            );
            functionCallText.innerHTML = await marked.parse(explanation);
          }

          // Execute function calls
          const functionResponses = [];
          for (const fc of functionCallsToExecute) {
            const normalizedName = fc.name
              .replace(/([a-z])([A-Z])/g, '$1_$2')
              .replace(/-/g, '_')
              .toLowerCase();

            try {
              console.log(`Executing tool ${normalizedName} via MCP Client...`);
              const toolResult = await mcpClient.callTool({
                name: normalizedName,
                arguments: fc.args,
              });
              console.log('Tool result:', toolResult);

              // Log to the MCP logs tab in MapApp
              mapApp.addMcpLog(normalizedName, fc.args, true);

              functionResponses.push({
                functionResponse: {
                  name: fc.name,
                  response: toolResult,
                  id: fc.id,
                },
              });
            } catch (err) {
              console.error(`Error calling tool ${normalizedName}:`, err);
              mapApp.addMcpLog(normalizedName, fc.args, false);
              functionResponses.push({
                functionResponse: {
                  name: fc.name,
                  response: { error: String(err) },
                  id: fc.id,
                },
              });
            }
          }

          // Set the next message as the function responses
          currentInput = {message: functionResponses};
        }
      } catch (e: unknown) {
        // Catch for AI interaction errors.
        console.error('GenAI SDK Error:', e);
        const finalErrorMessage = extractErrorMessage(e);

        const isQuotaError =
          finalErrorMessage.toLowerCase().includes('quota') ||
          finalErrorMessage.toLowerCase().includes('limit') ||
          finalErrorMessage.toLowerCase().includes('resource_exhausted') ||
          finalErrorMessage.includes('429');

        const {textElement: errorTextElement} = mapApp.addMessage('error', '');
        
        if (isQuotaError) {
          errorTextElement.innerHTML = await marked.parse(
            `### ⚠️ Gemini API Quota Exceeded\n\n` +
            `The shared Gemini API key has exceeded its daily free-tier limit of **20 requests**.\n\n` +
            `To get a fresh, dedicated quota and continue immediately, you can easily use your own **Gemini API Key**:\n\n` +
            `1. **Get a free key:** Go to [Google AI Studio](https://aistudio.google.com/) and click **Get API Key**.\n` +
            `2. **Open Settings:** Click the **Settings** (⚙️ gear icon, top-right corner of this screen) → **Secrets**.\n` +
            `3. **Add Secret:** Add a secret named \`GEMINI_API_KEY\` and paste your key, then press **Enter**.\n\n` +
            `*The application will automatically rebuild and connect to your own key.*`
          );
        } else {
          errorTextElement.innerHTML = await marked.parse(
            `Error: ${finalErrorMessage}`,
          );
        }
      }

      // Post-processing logic (now inside the outer try)
      if (thinkingContainer && thinkingContainer.hasAttribute('open')) {
        if (!thoughtAccumulator) {
          thinkingContainer.classList.add('hidden');
        }
        thinkingContainer.removeAttribute('open');
      }

      if (
        textElement.innerHTML.trim() === '...' ||
        textElement.innerHTML.trim().length === 0
      ) {
        const hasFunctionCallMessage = mapApp.messages.some((el) =>
          el.innerHTML.includes('Calling function:'),
        );
        if (!hasFunctionCallMessage) {
          textElement.innerHTML = await marked.parse('Done.');
        } else if (textElement.innerHTML.trim() === '...') {
          textElement.innerHTML = '';
        }
      }
    } finally {
      // Finally for the outer try, ensures chat state is reset
      mapApp.setChatState(ChatState.IDLE);
    }
  };
});
