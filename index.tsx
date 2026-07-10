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

import {startMcpGoogleMapServer} from './mcp_maps_server';

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
4.  **Explain Actions and Add Fun Facts:** After initiating a map tool call, explain what you are displaying or adjusting, and share fascinating historical, scientific, or travel trivia about the destination.`;

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
    (params: {location?: string; origin?: string; destination?: string}) => {
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
          let functionCallsToExecute: any[] = [];

          for await (const chunk of stream) {
            for (const candidate of chunk.candidates ?? []) {
              for (const part of candidate.content?.parts ?? []) {
                if (part.functionCall) {
                  console.log(
                    'FUNCTION CALL:',
                    part.functionCall.name,
                    part.functionCall.args,
                  );
                  functionCallsToExecute.push(part.functionCall);

                  const normalizedName = part.functionCall.name!
                    .replace(/([a-z])([A-Z])/g, '$1_$2')
                    .replace(/-/g, '_')
                    .toLowerCase();

                  const mcpCall = {
                    name: normalizedName,
                    arguments: part.functionCall.args,
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

          if (functionCallsToExecute.length === 0) {
            break; // No more function calls, exit the loop
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
                },
              });
            } catch (err) {
              console.error(`Error calling tool ${normalizedName}:`, err);
              mapApp.addMcpLog(normalizedName, fc.args, false);
              functionResponses.push({
                functionResponse: {
                  name: fc.name,
                  response: { error: String(err) },
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
        let baseErrorText: string;

        if (e instanceof Error) {
          baseErrorText = e.message;
        } else if (typeof e === 'string') {
          baseErrorText = e;
        } else if (
          e &&
          typeof e === 'object' &&
          'message' in e &&
          typeof (e as {message: unknown}).message === 'string'
        ) {
          baseErrorText = (e as {message: string}).message;
        } else {
          try {
            // Attempt to stringify complex objects, otherwise, simple String conversion.
            baseErrorText = `Unexpected error: ${JSON.stringify(e)}`;
          } catch (stringifyError) {
            baseErrorText = `Unexpected error: ${String(e)}`;
          }
        }

        let finalErrorMessage = baseErrorText; // Start with the extracted/formatted base error message.

        // Attempt to parse a JSON object from the baseErrorText, as some SDK errors embed details this way.
        // This is useful if baseErrorText itself is a string containing JSON.
        const jsonStartIndex = baseErrorText.indexOf('{');
        const jsonEndIndex = baseErrorText.lastIndexOf('}');

        if (jsonStartIndex > -1 && jsonEndIndex > jsonStartIndex) {
          const potentialJson = baseErrorText.substring(
            jsonStartIndex,
            jsonEndIndex + 1,
          );
          try {
            const sdkError = JSON.parse(potentialJson);
            let refinedMessageFromSdkJson: string | undefined;

            // Check for common nested error structures (e.g., sdkError.error.message)
            // or a direct message (sdkError.message) in the parsed JSON.
            if (
              sdkError &&
              typeof sdkError === 'object' &&
              sdkError.error && // Check if 'error' property exists and is truthy
              typeof sdkError.error === 'object' && // Check if 'error' property is an object
              typeof sdkError.error.message === 'string' // Check for 'message' string within 'error' object
            ) {
              refinedMessageFromSdkJson = sdkError.error.message;
            } else if (
              sdkError &&
              typeof sdkError === 'object' && // Check if sdkError itself is an object
              typeof sdkError.message === 'string' // Check for a direct 'message' string on sdkError
            ) {
              refinedMessageFromSdkJson = sdkError.message;
            }

            if (refinedMessageFromSdkJson) {
              finalErrorMessage = refinedMessageFromSdkJson; // Update if JSON parsing yielded a more specific message
            }
          } catch (parseError) {
            // If parsing fails, finalErrorMessage remains baseErrorText.
            console.warn(
              'Could not parse potential JSON from error message; using base error text.',
              parseError,
            );
          }
        }

        const {textElement: errorTextElement} = mapApp.addMessage('error', '');
        errorTextElement.innerHTML = await marked.parse(
          `Error: ${finalErrorMessage}`,
        );
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
