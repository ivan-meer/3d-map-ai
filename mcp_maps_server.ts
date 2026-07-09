/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This file defines and runs an MCP (Model Context Protocol) server.
 * The server exposes tools that an AI model (like Gemini) can call to interact
 * with Google Maps functionality. These tools include:
 * - `view_location_google_maps`: To display a specific location.
 * - `directions_on_google_maps`: To get and display directions.
 *
 * When the AI decides to use one of these tools, the MCP server receives the
 * call and then uses the `mapQueryHandler` callback to send the relevant
 * parameters (location, origin/destination) to the frontend
 * (MapApp component in map_app.ts) to update the map display.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {z} from 'zod';

export interface MapParams {
  location?: string;
  origin?: string;
  destination?: string;
  weather?: boolean;
  poi?: {
    enable: boolean;
    radius?: number;
    category?: string;
  };
  camera?: {
    tilt?: number;
    heading?: number;
    range?: number;
  };
  bookmark?: {
    action: 'add' | 'list';
    name?: string;
  };
  tour?: {
    action: 'play' | 'stop';
  };
  _toolCallName?: string;
  _toolCallArgs?: any;
}

export async function startMcpGoogleMapServer(
  transport: Transport,
  /**
   * Callback function provided by the frontend (index.tsx) to handle map updates.
   * This function is invoked when an AI tool call requires a map interaction,
   * passing the necessary parameters to update the map view (e.g., show location,
   * display directions). It is the bridge between MCP server tool execution and
   * the visual map representation in the MapApp component.
   */
  mapQueryHandler: (params: MapParams) => void,
) {
  // Create an MCP server
  const server = new McpServer({
    name: 'AI Studio Google Map',
    version: '1.0.0',
  });

  server.tool(
    'view_location_google_maps',
    'View a specific query or geographical location and display in the embedded maps interface',
    {query: z.string()},
    async ({query}) => {
      mapQueryHandler({
        location: query,
        _toolCallName: 'view_location_google_maps',
        _toolCallArgs: {query}
      });
      return {
        content: [{type: 'text', text: `Navigating to: ${query}`}],
      };
    },
  );

  server.tool(
    'directions_on_google_maps',
    'Search google maps for directions from origin to destination.',
    {origin: z.string(), destination: z.string()},
    async ({origin, destination}) => {
      mapQueryHandler({
        origin,
        destination,
        _toolCallName: 'directions_on_google_maps',
        _toolCallArgs: {origin, destination}
      });
      return {
        content: [
          {type: 'text', text: `Navigating from ${origin} to ${destination}`},
        ],
      };
    },
  );

  server.tool(
    'toggle_weather_overlay',
    'Enable or disable the live weather layer/overlay on the map',
    {enable: z.boolean()},
    async ({enable}) => {
      mapQueryHandler({
        weather: enable,
        _toolCallName: 'toggle_weather_overlay',
        _toolCallArgs: {enable}
      });
      return {
        content: [{type: 'text', text: `${enable ? 'Enabled' : 'Disabled'} live weather overlay.`}],
      };
    },
  );

  server.tool(
    'toggle_poi_markers',
    'Show or hide nearby Point of Interest (POI) attraction markers around the current map center',
    {
      enable: z.boolean(),
      radius: z.number().optional().describe('Search radius in meters (e.g., 1500)'),
      category: z.enum(['all', 'museums', 'parks', 'religious']).optional().describe('Filter by specific category')
    },
    async ({enable, radius, category}) => {
      mapQueryHandler({
        poi: { enable, radius, category },
        _toolCallName: 'toggle_poi_markers',
        _toolCallArgs: {enable, radius, category}
      });
      return {
        content: [{type: 'text', text: `${enable ? 'Showing' : 'Hiding'} nearby attractions on the map.`}],
      };
    },
  );

  server.tool(
    'set_map_camera',
    'Set 3D camera properties like heading (rotation in degrees, 0=North, 90=East), tilt (angle in degrees, 0=top-down, 90=horizon), and range (zoom level in meters)',
    {
      tilt: z.number().optional().describe('Camera angle in degrees (0 to 90)'),
      heading: z.number().optional().describe('Camera heading in degrees (0 to 360, where 0 is North)'),
      range: z.number().optional().describe('Camera range/zoom in meters (e.g., 1000 for close-up, 100000 for city view)')
    },
    async ({tilt, heading, range}) => {
      mapQueryHandler({
        camera: { tilt, heading, range },
        _toolCallName: 'set_map_camera',
        _toolCallArgs: {tilt, heading, range}
      });
      return {
        content: [{type: 'text', text: 'Updating map camera perspective.'}],
      };
    },
  );

  server.tool(
    'manage_bookmarks',
    'Save the current camera view as a bookmark, or check existing bookmarks',
    {
      action: z.enum(['add', 'list']),
      name: z.string().optional().describe('Name for the saved bookmark (required if action is add)')
    },
    async ({action, name}) => {
      mapQueryHandler({
        bookmark: { action, name },
        _toolCallName: 'manage_bookmarks',
        _toolCallArgs: {action, name}
      });
      return {
        content: [{type: 'text', text: action === 'add' ? `Saved view: ${name || 'Untitled bookmark'}` : 'Checking saved views.'}],
      };
    },
  );

  server.tool(
    'manage_tour',
    'Play or stop the auto-tour through saved bookmarks/locations',
    {action: z.enum(['play', 'stop'])},
    async ({action}) => {
      mapQueryHandler({
        tour: { action },
        _toolCallName: 'manage_tour',
        _toolCallArgs: {action}
      });
      return {
        content: [{type: 'text', text: `${action === 'play' ? 'Started' : 'Stopped'} the map auto-tour.`}],
      };
    },
  );

  await server.connect(transport);
  console.log('server running');
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
