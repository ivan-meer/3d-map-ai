/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This file defines the main `gdm-map-app` LitElement component.
 * This component is responsible for:
 * - Rendering the user interface, including the Google Photorealistic 3D Map,
 *   chat messages area, and user input field.
 * - Managing the state of the chat (e.g., idle, generating, thinking).
 * - Handling user input and sending messages to the Gemini AI model.
 * - Processing responses from the AI, including displaying text and handling
 *   function calls (tool usage) related to map interactions.
 * - Integrating with the Google Maps JavaScript API to load and control the map,
 *   display markers, polylines for routes, and geocode locations.
 * - Providing the `handleMapQuery` method, which is called by the MCP server
 *   (via index.tsx) to update the map based on AI tool invocations.
 */

// Google Maps JS API Loader: Used to load the Google Maps JavaScript API.
import {Loader} from '@googlemaps/js-api-loader';
import hljs from 'highlight.js';
import {html, LitElement, PropertyValueMap} from 'lit';
import {customElement, query, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {Marked} from 'marked';
import {markedHighlight} from 'marked-highlight';

import {MapParams} from './mcp_maps_server';

/** Markdown formatting function with syntax hilighting */
export const marked = new Marked(
  markedHighlight({
    async: true,
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang, info) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, {language}).value;
    },
  }),
);

const ICON_BUSY = html`<svg
  class="rotating"
  xmlns="http://www.w3.org/2000/svg"
  height="24px"
  viewBox="0 -960 960 960"
  width="24px"
  fill="currentColor">
  <path
    d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-155.5t86-127Q252-817 325-848.5T480-880q17 0 28.5 11.5T520-840q0 17-11.5 28.5T480-800q-133 0-226.5 93.5T160-480q0 133 93.5 226.5T480-160q133 0 226.5-93.5T800-480q0-17 11.5-28.5T840-520q17 0 28.5 11.5T880-480q0 82-31.5 155t-86 127.5q-54.5 54.5-127 86T480-80Z" />
</svg>`;

/**
 * Chat state enum to manage the current state of the chat interface.
 */
export enum ChatState {
  IDLE,
  GENERATING,
  THINKING,
  EXECUTING,
}

/**
 * Chat tab enum to manage the current selected tab in the chat interface.
 */
enum ChatTab {
  GEMINI,
  SETTINGS,
}

/**
 * Chat role enum to manage the current role of the message.
 */
export enum ChatRole {
  USER,
  ASSISTANT,
  SYSTEM,
}

// Google Maps API Key: Read from the environment variable GOOGLE_MAPS_PLATFORM_KEY
// configured in AI Studio Secrets.
const USER_PROVIDED_GOOGLE_MAPS_API_KEY: string =
  process.env.GOOGLE_MAPS_PLATFORM_KEY || '';

const EXAMPLE_PROMPTS = [
  "Show me directions from Tokyo Tower to Shibuya Crossing.",
  "Can you show me a beautiful beach?",
  "Show me San Francisco",
  "Give me directions from the Eiffel Tower to the Louvre Museum.",
  "Where is a place with a tilted tower?",
  "Can you show me Diamond Head in Hawaii?",
  "Let's go to Venice, Italy.",
  "Take me to the northernmost capital city in the world",
  "What's the way from Buckingham Palace to the Tower of London?",
  "How about the southernmost permanently inhabited settlement? What's it called and where is it?",
  "Let's jump to Machu Picchu in Peru",
  "Can you show me the Three Gorges Dam in China?",
  "Can you find a town or city with an unusual name and show it to me?",
  "How do I get from Times Square, New York to Central Park?",
  "Show me the route from the Golden Gate Bridge to Alcatraz Island.",
];

/**
 * MapApp component for Photorealistic 3D Maps.
 */
@customElement('gdm-map-app')
export class MapApp extends LitElement {
  @query('#anchor') anchor?: HTMLDivElement;
  // Google Maps: Reference to the <gmp-map-3d> DOM element where the map is rendered.
  @query('#mapContainer') mapContainerElement?: HTMLElement; // Will be <gmp-map-3d>
  @query('#messageInput') messageInputElement?: HTMLInputElement;

  @state() chatState = ChatState.IDLE;
  @state() isRunning = true;
  @state() selectedChatTab = ChatTab.GEMINI;
  @state() inputMessage = '';
  @state() messages: HTMLElement[] = [];
  @state() mapInitialized = false;
  @state() mapError = '';
  @state() mapMode: 'hybrid' | 'satellite' = 'hybrid';
  @state() defaultUiDisabled = true;
  @state() mapHeading = 315;
  @state() mapTilt = 60;
  @state() mapRange = 2500;
  @state() flyDuration = 3000;
  @state() manualSearchQuery = '';
  @state() manualOrigin = '';
  @state() manualDestination = '';
  @state() isOrbiting = false;
  @state() showWeatherOverlay = false;
  @state() weatherData: any = null;
  @state() weatherLoading = false;
  @state() weatherError = '';
  @state() bookmarks: Array<{id: string, name: string, lat: number, lng: number, tilt: number, heading: number, range: number}> = [];
  @state() newBookmarkName = '';
  @state() bookmarkIsSaving = false;
  @state() appTheme: 'light' | 'dark' = 'dark';
  @state() showPoiMarkers = false;
  @state() poiLoading = false;
  @state() poiSearchRadius = 1500;
  @state() copiedBookmarkId = '';
  @state() editingBookmarkId = '';
  @state() editingBookmarkName = '';
  @state() autoOrbitOnLoad = false;
  @state() autoSaveBookmarkEnabled = false;
  @state() autoSaveBookmarkDelay = 5;
  @state() activeBookmarkId = '';
  @state() selectedCategoryFilter = 'All';
  @state() timelineVisible = true;
  @state() centerLat = 37.8199;
  @state() centerLng = -122.4783;
  @state() recentSearches: string[] = [];

  // Google Maps: Instance of the Google Maps 3D map.
  private map?: any;
  // Google Maps: Reference to existing POI markers
  private poiMarkers: any[] = [];
  // Google Maps: Instance of the Google Maps Geocoding service.
  private geocoder?: any;
  // Google Maps: Instance of the current map marker (Marker3DElement).
  private marker?: any;
  private flyToTimeoutId?: any;
  private autoSaveTimer?: any;

  // Google Maps: References to 3D map element constructors.
  private Map3DElement?: any;
  private Marker3DElement?: any;
  private Marker3DInteractiveElement?: any;
  private Polyline3DElement?: any;

  // Google Maps: Instance of the current route polyline.
  private routePolyline?: any;
  // Google Maps: Markers for origin and destination of a route.
  private originMarker?: any;
  private destinationMarker?: any;

  sendMessageHandler?: CallableFunction;

  constructor() {
    super();
    // Set initial input from a random example prompt
    this.setNewRandomPrompt();
    this.loadBookmarks();
    this.initTheme();
    try {
      this.autoOrbitOnLoad = localStorage.getItem('gdm_map_auto_orbit') === 'true';
    } catch (e) {
      this.autoOrbitOnLoad = false;
    }
    try {
      this.autoSaveBookmarkEnabled = localStorage.getItem('gdm_map_auto_save_enabled') === 'true';
    } catch (e) {
      this.autoSaveBookmarkEnabled = false;
    }
    try {
      const storedDelay = localStorage.getItem('gdm_map_auto_save_delay');
      this.autoSaveBookmarkDelay = storedDelay ? parseInt(storedDelay, 10) : 5;
    } catch (e) {
      this.autoSaveBookmarkDelay = 5;
    }
    try {
      const storedSearches = localStorage.getItem('gdm_map_recent_searches');
      this.recentSearches = storedSearches ? JSON.parse(storedSearches) : [];
    } catch (e) {
      this.recentSearches = [];
    }
    try {
      const storedTimelineVisible = localStorage.getItem('gdm_map_timeline_visible');
      this.timelineVisible = storedTimelineVisible !== 'false';
    } catch (e) {
      this.timelineVisible = true;
    }
  }

  createRenderRoot() {
    return this;
  }

  protected firstUpdated(
    _changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>,
  ): void {
    // Google Maps: Load the map when the component is first updated.
    this.loadMap();
  }

  /**
   * Sets the input message to a new random prompt from EXAMPLE_PROMPTS.
   */
  private setNewRandomPrompt() {
    if (EXAMPLE_PROMPTS.length > 0) {
      this.inputMessage =
        EXAMPLE_PROMPTS[Math.floor(Math.random() * EXAMPLE_PROMPTS.length)];
    }
  }

  /**
   * Google Maps: Loads the Google Maps JavaScript API using the JS API Loader.
   * It initializes necessary map services like Geocoding and Directions,
   * and imports 3D map elements (Map3DElement, Marker3DElement, Polyline3DElement).
   * Handles API key validation and error reporting.
   */
  async loadMap() {
    const isApiKeyPlaceholder =
      !USER_PROVIDED_GOOGLE_MAPS_API_KEY ||
      USER_PROVIDED_GOOGLE_MAPS_API_KEY === 'YOUR_ACTUAL_GOOGLE_MAPS_API_KEY_REPLACE_ME' ||
      USER_PROVIDED_GOOGLE_MAPS_API_KEY === 'PLACEHOLDER_API_KEY';

    if (isApiKeyPlaceholder) {
      this.mapError = `Google Maps API Key Required

To add your Google Maps API key:
1. Get an API key from Google Cloud Console:
   https://console.cloud.google.com/google/maps-apis/start?utm_campaign=gmp-code-assist-ais
2. Open Settings (⚙️ gear icon, top-right corner) → Secrets.
3. Add a secret named GOOGLE_MAPS_PLATFORM_KEY and paste your API key as the value.
4. Press Enter. The app will rebuild automatically.`;
      console.error(this.mapError);
      this.requestUpdate();
      return;
    }

    const loader = new Loader({
      apiKey: USER_PROVIDED_GOOGLE_MAPS_API_KEY,
      version: 'beta', // Using 'beta' for Photorealistic 3D Maps features
      libraries: ['geocoding', 'routes', 'geometry', 'places'], // Request necessary libraries
    });

    try {
      await loader.load();
      // Google Maps: Import 3D map specific library elements.
      const maps3dLibrary = await (window as any).google.maps.importLibrary(
        'maps3d',
      );
      this.Map3DElement = maps3dLibrary.Map3DElement;
      this.Marker3DElement = maps3dLibrary.Marker3DElement;
      this.Marker3DInteractiveElement = maps3dLibrary.Marker3DInteractiveElement || maps3dLibrary.Marker3DElement;
      this.Polyline3DElement = maps3dLibrary.Polyline3DElement;

      // Google Maps: Initialize the map itself.
      this.initializeMap();
      this.mapInitialized = true;
      this.mapError = '';
    } catch (error) {
      console.error('Error loading Google Maps API:', error);
      this.mapError =
        'Could not load Google Maps. Check console for details and ensure API key is correct. If using 3D features, ensure any necessary Map ID is correctly configured if required programmatically.';
      this.mapInitialized = false;
    }
    this.requestUpdate();
  }

  /**
   * Google Maps: Initializes the map instance and the Geocoder service.
   * This is called after the Google Maps API has been successfully loaded.
   */
  initializeMap() {
    if (!this.mapContainerElement || !this.Map3DElement) {
      console.error('Map container or Map3DElement class not ready.');
      return;
    }
    // Google Maps: Assign the <gmp-map-3d> element to the map property.
    this.map = this.mapContainerElement;
    if ((window as any).google && (window as any).google.maps) {
      // Google Maps: Initialize the Geocoder.
      this.geocoder = new (window as any).google.maps.Geocoder();
    } else {
      console.error('Geocoder not loaded.');
    }

    const params = new URLSearchParams(window.location.search);
    const paramLat = params.get('lat');
    const paramLng = params.get('lng');
    const paramTilt = params.get('tilt');
    const paramHeading = params.get('heading');
    const paramRange = params.get('range');

    let initLat = 37.8199;
    let initLng = -122.4783;
    if (paramLat !== null && paramLng !== null) {
      initLat = parseFloat(paramLat);
      initLng = parseFloat(paramLng);
    }
    if (paramTilt !== null) {
      this.mapTilt = Math.round(parseFloat(paramTilt));
    }
    if (paramHeading !== null) {
      this.mapHeading = Math.round(parseFloat(paramHeading));
    }
    if (paramRange !== null) {
      this.mapRange = Math.round(parseFloat(paramRange));
    }

    // Set initial map parameters programmatically to prevent Lit template fighting/snapping
    this.map.center = {lat: initLat, lng: initLng, altitude: 0};
    this.centerLat = initLat;
    this.centerLng = initLng;
    this.map.heading = this.mapHeading;
    this.map.tilt = this.mapTilt;
    this.map.range = this.mapRange;
    this.map.mode = this.mapMode.toUpperCase();
    this.map.defaultUiDisabled = this.defaultUiDisabled;

    if (this.autoOrbitOnLoad && paramLat !== null) {
      this.isOrbiting = true;
      this._runOrbit();
    }

    // Register camera and mode change listeners to keep the settings sliders in sync
    this.map.addEventListener('gmp-headingchange', () => {
      if (this.map && this.map.heading !== undefined) {
        this.mapHeading = Math.round(this.map.heading);
      }
      this.resetAutoSaveTimer();
    });
    this.map.addEventListener('gmp-tiltchange', () => {
      if (this.map && this.map.tilt !== undefined) {
        this.mapTilt = Math.round(this.map.tilt);
      }
      this.resetAutoSaveTimer();
    });
    this.map.addEventListener('gmp-rangechange', () => {
      if (this.map && this.map.range !== undefined) {
        this.mapRange = Math.round(this.map.range);
      }
      this.resetAutoSaveTimer();
    });
    this.map.addEventListener('gmp-centerchange', () => {
      this.handleCenterChange();
      this.resetAutoSaveTimer();
    });
  }

  setChatState(state: ChatState) {
    this.chatState = state;
  }

  /**
   * Google Maps: Clears existing map elements like markers and polylines
   * before adding new ones. This ensures the map doesn't get cluttered with
   * old search results or routes.
   */
  private _clearMapElements() {
    if (this.marker) {
      this.marker.remove();
      this.marker = undefined;
    }
    if (this.routePolyline) {
      this.routePolyline.remove();
      this.routePolyline = undefined;
    }
    if (this.originMarker) {
      this.originMarker.remove();
      this.originMarker = undefined;
    }
    if (this.destinationMarker) {
      this.destinationMarker.remove();
      this.destinationMarker = undefined;
    }
  }

  /**
   * Google Maps: Handles viewing a specific location on the map.
   * It uses the Geocoding service to find coordinates for the `locationQuery`,
   * then flies the camera to that location and places a 3D marker.
   * @param locationQuery The string query for the location (e.g., "Eiffel Tower").
   */
  private async _handleViewLocation(locationQuery: string) {
    if (
      !this.mapInitialized ||
      !this.map ||
      !this.geocoder ||
      !this.Marker3DElement
    ) {
      if (!this.mapError) {
        const {textElement} = this.addMessage('error', 'Processing error...');
        textElement.innerHTML = await marked.parse(
          'Map is not ready to display locations. Please check configuration.',
        );
      }
      console.warn(
        'Map not initialized, geocoder or Marker3DElement not available, cannot render query.',
      );
      return;
    }
    this._clearMapElements(); // Google Maps: Clear previous elements.

    // Google Maps: Use Geocoding service to find the location.
    this.geocoder.geocode(
      {address: locationQuery},
      async (results: any, status: string) => {
        if (status === 'OK' && results && results[0] && this.map) {
          const location = results[0].geometry.location;

          // Google Maps: Define camera options and fly to the location.
          const cameraOptions = {
            center: {lat: location.lat(), lng: location.lng(), altitude: 0},
            heading: 0,
            tilt: 67.5,
            range: 2000, // Distance from the target in meters
          };
          
          // Update settings slider states to match
          this.mapHeading = 0;
          this.mapTilt = 67.5;
          this.mapRange = 2000;

          (this.map as any).flyCameraTo({
            endCamera: cameraOptions,
            durationMillis: this.flyDuration,
          });

          // Google Maps: Create and add a 3D marker to the map.
          this.marker = new this.Marker3DElement();
          this.marker.position = {
            lat: location.lat(),
            lng: location.lng(),
            altitude: 0,
          };
          const label =
            locationQuery.length > 30
              ? locationQuery.substring(0, 27) + '...'
              : locationQuery;
          this.marker.label = label;
          (this.map as any).appendChild(this.marker);
        } else {
          console.error(
            `Geocode was not successful for "${locationQuery}". Reason: ${status}`,
          );
          const rawErrorMessage = `Could not find location: ${locationQuery}. Reason: ${status}`;
          const {textElement} = this.addMessage('error', 'Processing error...');
          textElement.innerHTML = await marked.parse(rawErrorMessage);
        }
      },
    );
  }

  /**
   * Geocodes a single address query and returns its LatLng coordinate object.
   */
  private _geocodeAddress(address: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.geocoder) {
        reject(new Error('Geocoder not initialized'));
        return;
      }
      this.geocoder.geocode({address}, (results: any, status: string) => {
        if (status === 'OK' && results && results[0]) {
          resolve(results[0].geometry.location);
        } else {
          reject(new Error(`Geocode failed with status: ${status}`));
        }
      });
    });
  }

  /**
   * Generates a 3D parabolic flight arc between two coordinates.
   */
  private _generateArcPath(originLoc: any, destLoc: any, steps = 30): any[] {
    const coords: any[] = [];
    const originLat = originLoc.lat();
    const originLng = originLoc.lng();
    const destLat = destLoc.lat();
    const destLng = destLoc.lng();

    let maxAlt = 2000; // default flight altitude in meters
    if ((window as any).google?.maps?.geometry?.spherical) {
      const spherical = (window as any).google.maps.geometry.spherical;
      const distance = spherical.computeDistanceBetween(originLoc, destLoc);
      maxAlt = Math.max(200, Math.min(200000, distance * 0.12));
    } else {
      // rough distance approximation
      const dLat = destLat - originLat;
      const dLng = destLng - originLng;
      const approxDist = Math.sqrt(dLat * dLat + dLng * dLng) * 111000;
      maxAlt = Math.max(200, Math.min(200000, approxDist * 0.12));
    }

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Linear interpolation for lat/lng (good enough for 3D visual path)
      const lat = originLat + (destLat - originLat) * t;
      const lng = originLng + (destLng - originLng) * t;
      // Parabolic altitude arc
      const altitude = maxAlt * Math.sin(t * Math.PI);
      coords.push({lat, lng, altitude});
    }
    return coords;
  }

  /**
   * Google Maps: Handles displaying directions between an origin and destination.
   * It uses the DirectionsService to calculate the route, then draws a 3D polyline
   * for the route and places 3D markers at the origin and destination.
   * The camera is adjusted to fit the entire route.
   * @param originQuery The starting point for directions.
   * @param destinationQuery The ending point for directions.
   */
  private async _handleDirections(
    originQuery: string,
    destinationQuery: string,
  ) {
    if (
      !this.mapInitialized ||
      !this.map ||
      !this.directionsService ||
      !this.Marker3DElement ||
      !this.Polyline3DElement
    ) {
      if (!this.mapError) {
        const {textElement} = this.addMessage('error', 'Processing error...');
        textElement.innerHTML = await marked.parse(
          'Map is not ready for directions. Please check configuration.',
        );
      }
      console.warn(
          'Map not initialized or DirectionsService/3D elements not available, cannot render directions.',
      );
      return;
    }
    this._clearMapElements(); // Google Maps: Clear previous elements.

    // Google Maps: Use modern Routes API to get the route.
    try {
      const google = (window as any).google;
      if (!google || !google.maps) {
        throw new Error('Google Maps API is not loaded');
      }

      const { Route } = await google.maps.importLibrary('routes');
      
      const response = await Route.computeRoutes({
        origin: originQuery,
        destination: destinationQuery,
        travelMode: 'DRIVING',
        fields: ['path', 'legs.startLocation', 'legs.endLocation', 'viewport'],
      });

      if (response && response.routes && response.routes.length > 0) {
        const route = response.routes[0];

        // Google Maps: Draw the route polyline using Polyline3DElement.
        if (route.path && this.Polyline3DElement) {
          const pathCoordinates = route.path.map((p: any) => ({
            lat: typeof p.lat === 'function' ? p.lat() : p.lat,
            lng: typeof p.lng === 'function' ? p.lng() : p.lng,
            altitude: 5,
          })); // Add slight altitude
          this.routePolyline = new this.Polyline3DElement();
          this.routePolyline.coordinates = pathCoordinates;
          this.routePolyline.strokeColor = 'blue';
          this.routePolyline.strokeWidth = 10;
          (this.map as any).appendChild(this.routePolyline);
        }

        // Google Maps: Add marker for the origin.
        const firstLeg = route.legs && route.legs[0];
        const originLocation = firstLeg && (firstLeg.startLocation || firstLeg.start_location);
        if (originLocation && this.Marker3DElement) {
          const oLat = typeof originLocation.lat === 'function' ? originLocation.lat() : (originLocation.lat ?? originLocation.latitude);
          const oLng = typeof originLocation.lng === 'function' ? originLocation.lng() : (originLocation.lng ?? originLocation.longitude);
          this.originMarker = new this.Marker3DElement();
          this.originMarker.position = {
            lat: oLat,
            lng: oLng,
            altitude: 0,
          };
          this.originMarker.label = 'Origin';
          this.originMarker.style = {
            color: {r: 0, g: 128, b: 0, a: 1}, // Green
          };
          (this.map as any).appendChild(this.originMarker);
        }

        // Google Maps: Add marker for the destination.
        const lastLeg = route.legs && route.legs[route.legs.length - 1];
        const destinationLocation = lastLeg && (lastLeg.endLocation || lastLeg.end_location);
        if (destinationLocation && this.Marker3DElement) {
          const dLat = typeof destinationLocation.lat === 'function' ? destinationLocation.lat() : (destinationLocation.lat ?? destinationLocation.latitude);
          const dLng = typeof destinationLocation.lng === 'function' ? destinationLocation.lng() : (destinationLocation.lng ?? destinationLocation.longitude);
          this.destinationMarker = new this.Marker3DElement();
          this.destinationMarker.position = {
            lat: dLat,
            lng: dLng,
            altitude: 0,
          };
          this.destinationMarker.label = 'Destination';
          this.destinationMarker.style = {
            color: {r: 255, g: 0, b: 0, a: 1}, // Red
          };
          (this.map as any).appendChild(this.destinationMarker);
        }

        // Google Maps: Adjust camera to fit the route bounds.
        let bounds = route.viewport;
        if (!bounds && route.path && route.path.length > 0) {
          const { LatLngBounds } = await google.maps.importLibrary('core');
          bounds = new LatLngBounds();
          route.path.forEach((p: any) => {
            bounds.extend(p);
          });
        }

        if (bounds) {
          const center = bounds.getCenter();
          const cLat = typeof center.lat === 'function' ? center.lat() : (center.lat ?? center.latitude);
          const cLng = typeof center.lng === 'function' ? center.lng() : (center.lng ?? center.longitude);
          let range = 10000; // Default range

          // Calculate a more appropriate range based on the route's diagonal distance
          if (
            google.maps.geometry &&
            google.maps.geometry.spherical
          ) {
            const spherical = google.maps.geometry.spherical;
            const ne = bounds.getNorthEast();
            const sw = bounds.getSouthWest();
            const diagonalDistance = spherical.computeDistanceBetween(ne, sw);
            range = diagonalDistance * 1.7; // Multiplier to ensure bounds are visible
          } else {
            console.warn(
              'google.maps.geometry.spherical not available for range calculation. Using fallback range.',
            );
          }

          range = Math.max(range, 2000); // Ensure a minimum sensible range

          const cameraOptions = {
            center: {lat: cLat, lng: cLng, altitude: 0},
            heading: 0,
            tilt: 45, // Tilt for better 3D perspective of the route
            range: range,
          };

          // Update settings slider states to match
          this.mapHeading = 0;
          this.mapTilt = 45;
          this.mapRange = Math.round(range);

          (this.map as any).flyCameraTo({
            endCamera: cameraOptions,
            durationMillis: this.flyDuration,
          });
        }
      } else {
        throw new Error('No routes returned from computeRoutes');
      }
    } catch (routeError: any) {
      console.error(
        `Routes API request failed. Origin: "${originQuery}", Destination: "${destinationQuery}". Error:`,
        routeError,
      );

      // Beautiful geocoding fallback for project setups without the Directions API enabled.
      try {
            const {textElement: infoMsg} = this.addMessage('assistant', 'Calculating direct 3D flight path...');
            infoMsg.innerHTML = await marked.parse(
              `*The modern Routes API returned an error (which usually means the Routes API is not enabled in your Google Cloud Console for this key).*\n\n**Falling back to a scenic 3D direct flight path!** Geocoding endpoints...`
            );

            const originLoc = await this._geocodeAddress(originQuery);
            const destLoc = await this._geocodeAddress(destinationQuery);

            if (this.Marker3DElement && this.Polyline3DElement) {
              // Draw 3D Arc Polyline
              const pathCoordinates = this._generateArcPath(originLoc, destLoc);
              this.routePolyline = new this.Polyline3DElement();
              this.routePolyline.coordinates = pathCoordinates;
              this.routePolyline.strokeColor = 'cyan';
              this.routePolyline.strokeWidth = 10;
              (this.map as any).appendChild(this.routePolyline);

              // Origin Marker
              this.originMarker = new this.Marker3DElement();
              this.originMarker.position = {
                lat: originLoc.lat(),
                lng: originLoc.lng(),
                altitude: 0,
              };
              this.originMarker.label = originQuery.length > 20 ? originQuery.substring(0, 17) + '...' : originQuery;
              this.originMarker.style = {
                color: {r: 0, g: 255, b: 128, a: 1},
              };
              (this.map as any).appendChild(this.originMarker);

              // Destination Marker
              this.destinationMarker = new this.Marker3DElement();
              this.destinationMarker.position = {
                lat: destLoc.lat(),
                lng: destLoc.lng(),
                altitude: 0,
              };
              this.destinationMarker.label = destinationQuery.length > 20 ? destinationQuery.substring(0, 17) + '...' : destinationQuery;
              this.destinationMarker.style = {
                color: {r: 255, g: 64, b: 64, a: 1},
              };
              (this.map as any).appendChild(this.destinationMarker);

              // Adjust camera bounds to show the entire flight arc
              const midLat = (originLoc.lat() + destLoc.lat()) / 2;
              const midLng = (originLoc.lng() + destLoc.lng()) / 2;

              let range = 10000;
              if ((window as any).google?.maps?.geometry?.spherical) {
                const spherical = (window as any).google.maps.geometry.spherical;
                const distance = spherical.computeDistanceBetween(originLoc, destLoc);
                range = distance * 1.5;
              } else {
                const dLat = destLoc.lat() - originLoc.lat();
                const dLng = destLoc.lng() - originLoc.lng();
                const approxDist = Math.sqrt(dLat * dLat + dLng * dLng) * 111000;
                range = approxDist * 1.5;
              }
              range = Math.max(range, 2500);

              const cameraOptions = {
                center: {lat: midLat, lng: midLng, altitude: 0},
                heading: 315, // Scenic angled perspective
                tilt: 55,     // Angled view to see the 3D arc
                range: range,
              };

              this.mapHeading = 315;
              this.mapTilt = 55;
              this.mapRange = Math.round(range);

              (this.map as any).flyCameraTo({
                endCamera: cameraOptions,
                durationMillis: this.flyDuration,
              });

              infoMsg.innerHTML = await marked.parse(
                `✈️ **Scenic 3D Flight Path Rendered!**\n\n*   **From:** ${originQuery}\n*   **To:** ${destinationQuery}\n*   **Flight Distance:** ${this.formatRange(Math.round(range / 1.5))}\n\n*You can use the settings panel on the right to rotate, tilt, or toggle the automatic target orbit!*`
              );
            }
          } catch (err: any) {
            console.error('Fallback geocoding or path rendering failed:', err);
            const rawErrorMessage = `Could not get directions from "${originQuery}" to "${destinationQuery}". Reason: ${routeError.message || routeError}. Fallback flight path also failed: ${err.message}`;
            const {textElement} = this.addMessage('error', 'Processing error...');
            textElement.innerHTML = await marked.parse(rawErrorMessage);
          }
    }
  }

  /**
   * Google Maps: This function is the primary interface for the MCP server (via index.tsx)
   * to trigger updates on the Google Map. When the AI model uses a map-related tool
   * (e.g., view location, get directions), the MCP server processes this request
   * and calls this function with the appropriate parameters.
   *
   * Based on the `params` received, this function will:
   * - If `params.location` is present, call `_handleViewLocation` to show a specific place.
   * - If `params.origin` and `params.destination` are present, call `_handleDirections`
   *   to display a route.
   * - If only `params.destination` is present (as a fallback), it will treat it as a location to view.
   *
   * This mechanism allows the AI's tool usage to be directly reflected on the map UI.
   * @param params An object containing parameters for the map query, like
   *               `location`, `origin`, or `destination`.
   */
  async handleMapQuery(params: MapParams) {
    if (params.location) {
      this._handleViewLocation(params.location);
    } else if (params.origin && params.destination) {
      this._handleDirections(params.origin, params.destination);
    } else if (params.destination) {
      // Fallback if only destination is provided, treat as viewing a location
      this._handleViewLocation(params.destination);
    }
  }

  setInputField(message: string) {
    this.inputMessage = message.trim();
  }

  addMessage(role: string, message: string) {
    const div = document.createElement('div');
    div.classList.add('turn');
    div.classList.add(`role-${role.trim()}`);
    div.setAttribute('aria-live', 'polite');

    const thinkingDetails = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Thinking process';
    thinkingDetails.classList.add('thinking');
    thinkingDetails.setAttribute('aria-label', 'Model thinking process');
    const thinkingElement = document.createElement('div');
    thinkingDetails.append(summary);
    thinkingDetails.append(thinkingElement);
    div.append(thinkingDetails);

    const textElement = document.createElement('div');
    textElement.className = 'text';
    textElement.innerHTML = message;
    div.append(textElement);

    this.messages = [...this.messages, div];
    this.scrollToTheEnd();
    return {
      thinkingContainer: thinkingDetails,
      thinkingElement: thinkingElement,
      textElement: textElement,
    };
  }

  scrollToTheEnd() {
    if (!this.anchor) return;
    this.anchor.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    });
  }

  async sendMessageAction(message?: string, role?: string) {
    if (this.chatState !== ChatState.IDLE) return;

    let msg = '';
    let usedComponentInput = false; // Flag to track if component's input was used

    if (message) {
      // Message is provided programmatically
      msg = message.trim();
    } else {
      // Message from the UI input field
      msg = this.inputMessage.trim();
      // Clear the input field state only if we are using its content
      // and there was actual content to send.
      if (msg.length > 0) {
        this.inputMessage = '';
        usedComponentInput = true;
      } else if (
        this.inputMessage.trim().length === 0 &&
        this.inputMessage.length > 0
      ) {
        // If inputMessage contained only whitespace, clear it and mark as used.
        this.inputMessage = '';
        usedComponentInput = true;
      }
    }

    if (msg.length === 0) {
      // If the final message to send is empty (e.g., user entered only spaces, or an empty programmatic message)
      // set a new random prompt if the component's input was cleared.
      if (usedComponentInput) {
        this.setNewRandomPrompt();
      }
      return;
    }

    const msgRole = role ? role.toLowerCase() : 'user';

    // Add user's message to the chat display
    if (msgRole === 'user' && msg) {
      this.addRecentSearch(msg);
      const {textElement} = this.addMessage(msgRole, '...');
      textElement.innerHTML = await marked.parse(msg);
    }

    // Send the message via the handler (to AI)
    if (this.sendMessageHandler) {
      await this.sendMessageHandler(msg, msgRole);
    }

    // If the component's main input field was used and cleared, set a new random prompt.
    if (usedComponentInput) {
      this.setNewRandomPrompt();
    }
  }

  private async inputKeyDownAction(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendMessageAction();
    }
  }

  flyTo(lat: number, lng: number, tilt: number, heading: number, range: number, bookmarkId?: string) {
    if (!this.mapInitialized || !this.map) return;

    this.activeBookmarkId = bookmarkId || '';

    // Stop any existing orbit/timeouts
    if (this.orbitAnimationId !== undefined) {
      cancelAnimationFrame(this.orbitAnimationId);
      this.orbitAnimationId = undefined;
    }
    this.isOrbiting = false;

    if (this.flyToTimeoutId !== undefined) {
      clearTimeout(this.flyToTimeoutId);
      this.flyToTimeoutId = undefined;
    }

    const cameraOptions = {
      center: {lat, lng, altitude: 0},
      heading,
      tilt,
      range,
    };
    this.mapHeading = heading;
    this.mapTilt = tilt;
    this.mapRange = range;
    
    (this.map as any).flyCameraTo({
      endCamera: cameraOptions,
      durationMillis: this.flyDuration,
    });

    if (this.autoOrbitOnLoad) {
      this.flyToTimeoutId = setTimeout(() => {
        this.isOrbiting = true;
        this._runOrbit();
        this.requestUpdate();
      }, this.flyDuration);
    }
  }

  formatRange(range: number): string {
    if (range >= 1000) {
      return `${(range / 1000).toFixed(1)} km`;
    }
    return `${range} m`;
  }

  onHeadingInput(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    this.mapHeading = val;
    if (this.map) {
      this.map.heading = val;
    }
  }

  onTiltInput(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    this.mapTilt = val;
    if (this.map) {
      this.map.tilt = val;
    }
  }

  onRangeInput(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    this.mapRange = val;
    if (this.map) {
      this.map.range = val;
    }
  }

  onModeChange(mode: 'hybrid' | 'satellite') {
    this.mapMode = mode;
    if (this.map) {
      this.map.mode = mode.toUpperCase();
    }
  }

  onDefaultUiChange(e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    this.defaultUiDisabled = !checked;
    if (this.map) {
      this.map.defaultUiDisabled = !checked;
    }
  }

  private mapUpdateDebounceTimeout?: any;

  handleCenterChange() {
    if (this.map && this.map.center) {
      const c = this.map.center;
      const latVal = typeof c.lat === 'function' ? c.lat() : (c.lat ?? c.latitude);
      const lngVal = typeof c.lng === 'function' ? c.lng() : (c.lng ?? c.longitude);
      if (latVal !== undefined && latVal !== null && lngVal !== undefined && lngVal !== null) {
        this.centerLat = latVal;
        this.centerLng = lngVal;
      }
    }
    if (!this.showWeatherOverlay && !this.showPoiMarkers) return;
    if (this.mapUpdateDebounceTimeout) {
      clearTimeout(this.mapUpdateDebounceTimeout);
    }
    this.mapUpdateDebounceTimeout = setTimeout(() => {
      if (this.showWeatherOverlay) {
        this.fetchWeatherForCenter();
      }
      if (this.showPoiMarkers) {
        this.fetchPoiForCenter();
      }
    }, 600);
  }

  isCurrentViewSaved(): boolean {
    if (!this.map) return false;
    const center = this.map.center;
    if (!center) return false;
    const lat = typeof center.lat === 'function' ? center.lat() : (center.lat ?? center.latitude);
    const lng = typeof center.lng === 'function' ? center.lng() : (center.lng ?? center.longitude);
    
    if (lat === undefined || lat === null || lng === undefined || lng === null) return false;

    return this.bookmarks.some(b => {
      const latDiff = Math.abs(b.lat - lat);
      const lngDiff = Math.abs(b.lng - lng);
      const headingDiff = Math.abs((b.heading - this.mapHeading + 360) % 360);
      const normalizedHeadingDiff = Math.min(headingDiff, 360 - headingDiff);
      const tiltDiff = Math.abs(b.tilt - this.mapTilt);
      const rangeDiff = Math.abs(b.range - this.mapRange) / Math.max(b.range, 1);

      // Coordinates within ~15 meters and tilt/heading/range extremely close
      return latDiff < 0.0002 && lngDiff < 0.0002 && normalizedHeadingDiff < 2 && tiltDiff < 2 && rangeDiff < 0.05;
    });
  }

  resetAutoSaveTimer() {
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
    }

    if (!this.autoSaveBookmarkEnabled || !this.map || this.isOrbiting) return;

    this.autoSaveTimer = setTimeout(() => {
      this.triggerAutoSave();
    }, this.autoSaveBookmarkDelay * 1000);
  }

  async triggerAutoSave() {
    if (!this.autoSaveBookmarkEnabled || !this.map || this.isOrbiting) return;
    
    if (this.isCurrentViewSaved()) {
      return;
    }

    const { textElement } = this.addMessage('assistant', 'Saving static view...');
    
    const center = this.map.center;
    if (!center) return;
    const lat = typeof center.lat === 'function' ? center.lat() : (center.lat ?? center.latitude);
    const lng = typeof center.lng === 'function' ? center.lng() : (center.lng ?? center.longitude);
    
    if (lat === undefined || lat === null || lng === undefined || lng === null) return;

    let name = '';
    if (this.geocoder) {
      try {
        name = await new Promise<string>((resolve) => {
          this.geocoder.geocode({ location: { lat, lng } }, (results: any, status: string) => {
            if (status === 'OK' && results && results[0]) {
              const address = results[0].formatted_address;
              resolve(address.split(',')[0] || `Auto-saved View`);
            } else {
              resolve(`Auto-saved View (${lat.toFixed(3)}, ${lng.toFixed(3)})`);
            }
          });
        });
      } catch {
        name = `Auto-saved View (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
      }
    } else {
      name = `Auto-saved View (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
    }

    const newBookmark = {
      id: Date.now().toString(),
      name: `${name} (Auto-saved)`,
      lat,
      lng,
      tilt: this.mapTilt,
      heading: this.mapHeading,
      range: this.mapRange
    };

    this.bookmarks = [newBookmark, ...this.bookmarks];
    this.saveBookmarksToStorage();
    
    textElement.innerHTML = await marked.parse(
      `📸 **Auto-saved View:** Added **"${newBookmark.name}"** to your bookmarks!`
    );
    this.requestUpdate();
  }

  toggleAutoSaveBookmark() {
    this.autoSaveBookmarkEnabled = !this.autoSaveBookmarkEnabled;
    try {
      localStorage.setItem('gdm_map_auto_save_enabled', String(this.autoSaveBookmarkEnabled));
    } catch (e) {
      console.error(e);
    }
    this.resetAutoSaveTimer();
  }

  changeAutoSaveDelay(delay: number) {
    this.autoSaveBookmarkDelay = delay;
    try {
      localStorage.setItem('gdm_map_auto_save_delay', String(this.autoSaveBookmarkDelay));
    } catch (e) {
      console.error(e);
    }
    this.resetAutoSaveTimer();
  }

  toggleTimelineVisibility() {
    this.timelineVisible = !this.timelineVisible;
    try {
      localStorage.setItem('gdm_map_timeline_visible', String(this.timelineVisible));
    } catch (e) {
      console.error(e);
    }
  }

  getCategoryEmoji(name: string): string {
    // Check if name has an emoji at the start
    const emojiRegex = /(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/;
    const match = name.match(emojiRegex);
    if (match && match.length > 0) {
      return match[0];
    }
    
    // Otherwise determine based on category
    const cat = this.getBookmarkCategory(name);
    switch (cat) {
      case 'Landmarks': return '🏛️';
      case 'Nature': return '🏞️';
      case 'Cities': return '🏙️';
      case 'Coastlines': return '🏖️';
      default: return '📍';
    }
  }

  handleTimelineWheel(e: WheelEvent) {
    const container = e.currentTarget as HTMLElement;
    if (container) {
      e.preventDefault();
      container.scrollLeft += e.deltaY;
    }
  }

  renderTimeline() {
    if (this.bookmarks.length === 0) return '';

    // Show chronologically: oldest first, latest last
    const chronologicalBookmarks = [...this.bookmarks].reverse();

    return html`
      <div class="map-timeline-island ${this.timelineVisible ? 'expanded' : 'collapsed'}">
        <div class="timeline-header">
          <div class="timeline-header-left">
            <span class="timeline-dot"></span>
            <span class="timeline-title">📍 Journey Route & Timeline</span>
            <span class="timeline-count-badge">${this.bookmarks.length} nodes</span>
          </div>
          <button class="timeline-collapse-btn" @click=${this.toggleTimelineVisibility} title="${this.timelineVisible ? 'Collapse Timeline' : 'Expand Timeline'}">
            ${this.timelineVisible ? html`
              <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
                <path d="M480-360 280-560h400L480-360Z"/>
              </svg>
            ` : html`
              <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
                <path d="m280-400 200-200 200 200H280Z"/>
              </svg>
            `}
          </button>
        </div>

        ${this.timelineVisible ? html`
          <div class="timeline-track-container" @wheel=${this.handleTimelineWheel}>
            <div class="timeline-connector-bar"></div>
            <div class="timeline-nodes">
              ${chronologicalBookmarks.map((b, index) => {
                const isActive = this.activeBookmarkId === b.id;
                const photoUrl = this.getBookmarkPhoto(b.name, b.id);
                const categoryEmoji = this.getCategoryEmoji(b.name);
                
                return html`
                  <div 
                    class="timeline-node ${isActive ? 'active' : ''}" 
                    @click=${() => this.flyTo(b.lat, b.lng, b.tilt, b.heading, b.range, b.id)}>
                    <div class="timeline-node-dot ${isActive ? 'active' : ''}">
                      <span class="timeline-node-index">${index + 1}</span>
                    </div>
                    <div class="timeline-node-card">
                      <div class="timeline-node-thumb">
                        <img src="${photoUrl}" alt="${b.name}" loading="lazy" />
                        <span class="timeline-node-emoji-badge">${categoryEmoji}</span>
                      </div>
                      <div class="timeline-node-details">
                        <span class="timeline-node-name" title="${b.name}">${b.name}</span>
                        <span class="timeline-node-coords">${b.lat.toFixed(3)}°, ${b.lng.toFixed(3)}°</span>
                      </div>
                    </div>
                  </div>
                `;
              })}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  toggleWeatherOverlay() {
    this.showWeatherOverlay = !this.showWeatherOverlay;
    if (this.showWeatherOverlay) {
      this.fetchWeatherForCenter();
    } else {
      this.weatherData = null;
      this.weatherError = '';
    }
  }

  togglePoiMarkers() {
    this.showPoiMarkers = !this.showPoiMarkers;
    if (this.showPoiMarkers) {
      this.fetchPoiForCenter();
    } else {
      this.clearPoiMarkers();
    }
  }

  onPoiRadiusInput(e: Event) {
    const target = e.target as HTMLInputElement;
    this.poiSearchRadius = parseInt(target.value, 10);
  }

  onPoiRadiusChange() {
    if (this.showPoiMarkers) {
      this.fetchPoiForCenter();
    }
  }

  async fetchPoiForCenter() {
    if (!this.map || !this.showPoiMarkers) return;
    const center = this.map.center;
    if (!center) return;

    const lat = typeof center.lat === 'function' ? center.lat() : (center.lat ?? center.latitude);
    const lng = typeof center.lng === 'function' ? center.lng() : (center.lng ?? center.longitude);

    if (lat === undefined || lat === null || lng === undefined || lng === null) {
      return;
    }

    this.clearPoiMarkers();

    this.poiLoading = true;
    this.requestUpdate();

    try {
      const google = (window as any).google;
      if (google && google.maps) {
        const { Place } = await google.maps.importLibrary('places');
        
        const response = await Place.searchNearby({
          locationRestriction: {
            center: { lat, lng },
            radius: this.poiSearchRadius,
          },
          includedTypes: ['tourist_attraction'],
          fields: ['displayName', 'location', 'formattedAddress']
        });

        this.poiLoading = false;
        
        if (response && response.places) {
          // Keep at most 15 markers to avoid cluttering the 3D map
          const limitedResults = response.places.slice(0, 15);
          limitedResults.forEach((place: any) => {
            const markerConstructor = this.Marker3DInteractiveElement || this.Marker3DElement;
            if (place.location && markerConstructor) {
              const marker = new markerConstructor();
              const pLat = typeof place.location.lat === 'function' ? place.location.lat() : place.location.lat;
              const pLng = typeof place.location.lng === 'function' ? place.location.lng() : place.location.lng;
              
              marker.label = place.displayName || 'Attraction';
              marker.style = {
                color: { r: 245, g: 158, b: 11, a: 1 } // Beautiful gold color
              };

              // Setup high-performance 3D hover/bounce interaction
              this.setupMarkerHover(marker, pLat, pLng);

              (this.map as any).appendChild(marker);
              this.poiMarkers.push(marker);
            }
          });
        }
      } else {
        this.poiLoading = false;
        console.error('google.maps is not available.');
      }
    } catch (e) {
      this.poiLoading = false;
      console.error('Error fetching POIs with Places API (New):', e);
    }
    this.requestUpdate();
  }

  setupMarkerHover(marker: any, pLat: number, pLng: number) {
    // Set properties for relative altitude so we can lift/bounce the marker in 3D
    marker.altitudeMode = 'relative-to-ground';
    marker.extruded = true; // Beautiful link connecting marker to ground

    const baseAlt = 15; // Set base floating height to 15m
    marker.position = {
      lat: pLat,
      lng: pLng,
      altitude: baseAlt
    };

    let animId: number | null = null;
    let startTime: number | null = null;
    let isHovered = false;

    const animateBounce = (timestamp: number) => {
      if (!isHovered) return;
      if (!startTime) startTime = timestamp;
      const elapsed = (timestamp - startTime) / 1000; // time in seconds

      // Sine wave bounce: Math.abs(Math.sin(...)) mimics a bounding ball/elastic spring
      const bounce = Math.abs(Math.sin(elapsed * Math.PI * 1.5)); // 1.5 Hz bounce frequency
      const currentAltitude = baseAlt + bounce * 25; // rise up to 40 meters above ground

      marker.position = {
        lat: pLat,
        lng: pLng,
        altitude: currentAltitude
      };

      // Visually pulse the color brighter gold when bouncing
      const r = Math.round(245 + bounce * 10);
      const g = Math.round(158 + bounce * 39);
      const b = Math.round(11 + bounce * 25);
      marker.style = {
        color: { r, g, b, a: 1 }
      };

      animId = requestAnimationFrame(animateBounce);
    };

    const onEnter = () => {
      isHovered = true;
      startTime = null;
      if (animId) cancelAnimationFrame(animId);
      animId = requestAnimationFrame(animateBounce);
    };

    const onLeave = () => {
      isHovered = false;
      if (animId) cancelAnimationFrame(animId);

      // Slide back to base altitude smoothly
      let returnStart: number | null = null;
      const startAlt = marker.position?.altitude ?? baseAlt;

      const animateReturn = (timestamp: number) => {
        if (isHovered) return;
        if (!returnStart) returnStart = timestamp;
        const progress = Math.min((timestamp - returnStart) / 250, 1); // 250ms slide

        const currentAltitude = startAlt + (baseAlt - startAlt) * progress;
        marker.position = {
          lat: pLat,
          lng: pLng,
          altitude: currentAltitude
        };

        // Transition color back to base gold
        const r = Math.round(245 + (1 - progress) * (((marker.style?.color?.r ?? 245)) - 245));
        const g = Math.round(158 + (1 - progress) * (((marker.style?.color?.g ?? 158)) - 158));
        const b = Math.round(11 + (1 - progress) * (((marker.style?.color?.b ?? 11)) - 11));
        marker.style = {
          color: { r, g, b, a: 1 }
        };

        if (progress < 1) {
          animId = requestAnimationFrame(animateReturn);
        } else {
          animId = null;
        }
      };

      animId = requestAnimationFrame(animateReturn);
    };

    marker.addEventListener('pointerenter', onEnter);
    marker.addEventListener('pointerleave', onLeave);
    marker.addEventListener('mouseenter', onEnter);
    marker.addEventListener('mouseleave', onLeave);

    marker._cleanupHover = () => {
      if (animId) cancelAnimationFrame(animId);
      marker.removeEventListener('pointerenter', onEnter);
      marker.removeEventListener('pointerleave', onLeave);
      marker.removeEventListener('mouseenter', onEnter);
      marker.removeEventListener('mouseleave', onLeave);
    };
  }

  clearPoiMarkers() {
    if (this.poiMarkers && this.poiMarkers.length > 0) {
      this.poiMarkers.forEach(marker => {
        try {
          if (marker._cleanupHover) {
            marker._cleanupHover();
          }
          marker.remove();
        } catch (e) {
          console.error('Error removing marker:', e);
        }
      });
      this.poiMarkers = [];
    }
  }

  async fetchWeatherForCenter() {
    if (!this.map) return;
    const center = this.map.center;
    if (!center) return;
    
    const lat = typeof center.lat === 'function' ? center.lat() : (center.lat ?? center.latitude);
    const lng = typeof center.lng === 'function' ? center.lng() : (center.lng ?? center.longitude);
    
    if (lat === undefined || lat === null || lng === undefined || lng === null) {
      this.weatherError = 'Could not retrieve map center coordinates.';
      return;
    }

    this.weatherLoading = true;
    this.weatherError = '';
    this.requestUpdate();
    
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current_weather=true`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Weather API returned status: ${response.status}`);
      }
      const data = await response.json();
      if (data && data.current_weather) {
        this.weatherData = {
          temperature: data.current_weather.temperature,
          windspeed: data.current_weather.windspeed,
          winddirection: data.current_weather.winddirection,
          weathercode: data.current_weather.weathercode,
          time: data.current_weather.time,
          lat: lat,
          lng: lng
        };
      } else {
        throw new Error('Invalid weather data structure received.');
      }
    } catch (err: any) {
      console.error('Error fetching weather data:', err);
      this.weatherError = 'Failed to fetch weather data.';
    } finally {
      this.weatherLoading = false;
      this.requestUpdate();
    }
  }

  getWeatherInfo(code: number): { label: string; icon: string; bgClass: string } {
    const weatherMap: Record<number, { label: string; icon: string; bgClass: string }> = {
      0: { label: 'Clear Sky', icon: '☀️', bgClass: 'weather-clear' },
      1: { label: 'Mainly Clear', icon: '🌤️', bgClass: 'weather-clear' },
      2: { label: 'Partly Cloudy', icon: '⛅', bgClass: 'weather-cloudy' },
      3: { label: 'Overcast', icon: '☁️', bgClass: 'weather-cloudy' },
      45: { label: 'Foggy', icon: '🌫️', bgClass: 'weather-fog' },
      48: { label: 'Depositing Rime Fog', icon: '🌫️', bgClass: 'weather-fog' },
      51: { label: 'Light Drizzle', icon: '🌧️', bgClass: 'weather-rainy' },
      53: { label: 'Moderate Drizzle', icon: '🌧️', bgClass: 'weather-rainy' },
      55: { label: 'Dense Drizzle', icon: '🌧️', bgClass: 'weather-rainy' },
      56: { label: 'Light Freezing Drizzle', icon: '🌧️❄️', bgClass: 'weather-rainy' },
      57: { label: 'Dense Freezing Drizzle', icon: '🌧️❄️', bgClass: 'weather-rainy' },
      61: { label: 'Slight Rain', icon: '🌧️', bgClass: 'weather-rainy' },
      63: { label: 'Moderate Rain', icon: '🌧️', bgClass: 'weather-rainy' },
      65: { label: 'Heavy Rain', icon: '🌧️', bgClass: 'weather-rainy' },
      66: { label: 'Light Freezing Rain', icon: '🌧️❄️', bgClass: 'weather-rainy' },
      67: { label: 'Heavy Freezing Rain', icon: '🌧️❄️', bgClass: 'weather-rainy' },
      71: { label: 'Slight Snowfall', icon: '❄️', bgClass: 'weather-snowy' },
      73: { label: 'Moderate Snowfall', icon: '❄️', bgClass: 'weather-snowy' },
      75: { label: 'Heavy Snowfall', icon: '❄️', bgClass: 'weather-snowy' },
      77: { label: 'Snow Grains', icon: '❄️', bgClass: 'weather-snowy' },
      80: { label: 'Slight Rain Showers', icon: '🌦️', bgClass: 'weather-rainy' },
      81: { label: 'Moderate Rain Showers', icon: '🌦️', bgClass: 'weather-rainy' },
      82: { label: 'Violent Rain Showers', icon: '🌦️', bgClass: 'weather-rainy' },
      85: { label: 'Slight Snow Showers', icon: '❄️🌦️', bgClass: 'weather-snowy' },
      86: { label: 'Heavy Snow Showers', icon: '❄️🌦️', bgClass: 'weather-snowy' },
      95: { label: 'Thunderstorm', icon: '⛈️', bgClass: 'weather-stormy' },
      96: { label: 'Thunderstorm with Slight Hail', icon: '⛈️🌨️', bgClass: 'weather-stormy' },
      99: { label: 'Thunderstorm with Heavy Hail', icon: '⛈️🌨️', bgClass: 'weather-stormy' },
    };
    return weatherMap[code] || { label: 'Unknown', icon: '🌡️', bgClass: 'weather-unknown' };
  }

  renderWeatherCard() {
    if (!this.showWeatherOverlay) {
      return html``;
    }

    if (this.weatherLoading) {
      return html`
        <div class="weather-overlay-card">
          <div class="weather-loading">
            <svg class="animate-spin" style="width: 20px; height: 20px; margin-right: 8px; display: inline-block; vertical-align: middle;" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" style="opacity: 0.25;"></circle>
              <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" style="opacity: 0.75;"></path>
            </svg>
            <span>Fetching weather...</span>
          </div>
        </div>
      `;
    }

    if (this.weatherError) {
      return html`
        <div class="weather-overlay-card weather-error-card">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="color: #ef4444; font-size: 1.2rem;">⚠️</span>
            <div>
              <div style="font-weight: 600; font-size: 0.85rem;">Weather Error</div>
              <div style="font-size: 0.75rem; opacity: 0.8;">${this.weatherError}</div>
            </div>
          </div>
          <button class="weather-retry-btn" @click=${this.fetchWeatherForCenter}>Retry</button>
        </div>
      `;
    }

    if (!this.weatherData) {
      return html``;
    }

    const { temperature, windspeed, weathercode, lat, lng } = this.weatherData;
    const weatherInfo = this.getWeatherInfo(weathercode);

    return html`
      <div class="weather-overlay-card ${weatherInfo.bgClass}">
        <div class="weather-card-header">
          <div class="weather-loc-details">
            <span class="weather-title">Center Weather</span>
            <span class="weather-coords">${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E</span>
          </div>
          <span class="weather-main-icon">${weatherInfo.icon}</span>
        </div>
        
        <div class="weather-temp-row">
          <span class="weather-temp-val">${temperature}°C</span>
          <span class="weather-desc">${weatherInfo.label}</span>
        </div>

        <div class="weather-stats-grid">
          <div class="weather-stat-item">
            <span class="weather-stat-icon">💨</span>
            <div class="weather-stat-info">
              <span class="weather-stat-label">Wind</span>
              <span class="weather-stat-value">${windspeed} km/h</span>
            </div>
          </div>
          <div class="weather-stat-item">
            <span class="weather-stat-icon">🧭</span>
            <div class="weather-stat-info">
              <span class="weather-stat-label">Wind Dir</span>
              <span class="weather-stat-value">${this.weatherData.winddirection}°</span>
            </div>
          </div>
        </div>
        
        <div class="weather-card-footer">
          Auto-updates as you pan/move the map
        </div>
      </div>
    `;
  }

  initTheme() {
    try {
      const storedTheme = localStorage.getItem('gdm_map_app_theme');
      if (storedTheme === 'light' || storedTheme === 'dark') {
        this.appTheme = storedTheme;
      } else {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        this.appTheme = prefersDark ? 'dark' : 'light';
      }
    } catch (e) {
      this.appTheme = 'light';
    }
    this.applyThemeToBody();
  }

  setAppTheme(theme: 'light' | 'dark') {
    this.appTheme = theme;
    try {
      localStorage.setItem('gdm_map_app_theme', theme);
    } catch (e) {
      console.error(e);
    }
    this.applyThemeToBody();
  }

  applyThemeToBody() {
    const body = document.body;
    if (this.appTheme === 'dark') {
      body.classList.remove('light-theme');
      body.classList.add('dark-theme');
    } else {
      body.classList.remove('dark-theme');
      body.classList.add('light-theme');
    }
  }

  loadBookmarks() {
    try {
      const stored = localStorage.getItem('gdm_map_bookmarks');
      if (stored) {
        this.bookmarks = JSON.parse(stored);
      } else {
        // Preset default landmarks to showcase the bookmark feature beautifully
        this.bookmarks = [
          { id: '1', name: '🗽 Statue of Liberty', lat: 40.6892, lng: -74.0445, tilt: 65, heading: 45, range: 600 },
          { id: '2', name: '🏟️ Colosseum, Rome', lat: 41.8902, lng: 12.4922, tilt: 60, heading: 135, range: 500 },
          { id: '3', name: '🗻 Mt. Fuji, Japan', lat: 35.3606, lng: 138.7274, tilt: 55, heading: 270, range: 5000 }
        ];
        this.saveBookmarksToStorage();
      }
    } catch (e) {
      console.error('Error loading bookmarks', e);
    }
  }

  saveBookmarksToStorage() {
    try {
      localStorage.setItem('gdm_map_bookmarks', JSON.stringify(this.bookmarks));
    } catch (e) {
      console.error('Error saving bookmarks', e);
    }
  }

  async saveCurrentAsBookmark() {
    if (!this.map) return;
    const center = this.map.center;
    if (!center) return;

    const lat = typeof center.lat === 'function' ? center.lat() : (center.lat ?? center.latitude);
    const lng = typeof center.lng === 'function' ? center.lng() : (center.lng ?? center.longitude);
    
    if (lat === undefined || lat === null || lng === undefined || lng === null) {
      return;
    }

    let name = this.newBookmarkName.trim();
    this.bookmarkIsSaving = true;
    this.requestUpdate();

    // If blank name, we try reverse-geocoding to name it nicely and intelligently!
    if (!name) {
      if (this.geocoder) {
        try {
          name = await new Promise<string>((resolve) => {
            this.geocoder.geocode({ location: { lat, lng } }, (results: any, status: string) => {
              if (status === 'OK' && results && results[0]) {
                const address = results[0].formatted_address;
                // Use the first segment of address (usually neighborhood/poi/street name)
                resolve(address.split(',')[0] || `View Point`);
              } else {
                resolve(`View (${lat.toFixed(3)}, ${lng.toFixed(3)})`);
              }
            });
          });
        } catch {
          name = `View (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
        }
      } else {
        name = `View (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
      }
    }

    const newBookmark = {
      id: Date.now().toString(),
      name,
      lat,
      lng,
      tilt: this.mapTilt,
      heading: this.mapHeading,
      range: this.mapRange
    };

    this.bookmarks = [newBookmark, ...this.bookmarks];
    this.saveBookmarksToStorage();
    this.newBookmarkName = '';
    this.bookmarkIsSaving = false;
    this.requestUpdate();
  }

  deleteBookmark(id: string) {
    if (this.activeBookmarkId === id) {
      this.activeBookmarkId = '';
    }
    const el = this.querySelector(`#bookmark-${id}`);
    if (el) {
      el.classList.add('removing');
      setTimeout(() => {
        this.bookmarks = this.bookmarks.filter(b => b.id !== id);
        this.saveBookmarksToStorage();
        this.requestUpdate();
      }, 300);
    } else {
      this.bookmarks = this.bookmarks.filter(b => b.id !== id);
      this.saveBookmarksToStorage();
      this.requestUpdate();
    }
  }

  getBookmarkPhoto(name: string, id: string): string {
    const lowerName = name.toLowerCase();
    
    const photos = {
      grand_canyon: 'https://images.unsplash.com/photo-1615551043360-33de8b5f410c?auto=format&fit=crop&w=150&h=150&q=80',
      eiffel: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?auto=format&fit=crop&w=150&h=150&q=80',
      everest: 'https://images.unsplash.com/photo-1544735716-392fe2489ffa?auto=format&fit=crop&w=150&h=150&q=80',
      venice: 'https://images.unsplash.com/photo-1527631746610-bca00a040d60?auto=format&fit=crop&w=150&h=150&q=80',
      machu: 'https://images.unsplash.com/photo-1587595431973-160d0d94adb1?auto=format&fit=crop&w=150&h=150&q=80',
      tokyo: 'https://images.unsplash.com/photo-1503899036084-c55cdd92da26?auto=format&fit=crop&w=150&h=150&q=80',
      new_york: 'https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?auto=format&fit=crop&w=150&h=150&q=80',
      gold_gate: 'https://images.unsplash.com/photo-1506012787146-f92b2d7d6d96?auto=format&fit=crop&w=150&h=150&q=80',
    };

    if (lowerName.includes('canyon')) return photos.grand_canyon;
    if (lowerName.includes('eiffel') || lowerName.includes('paris') || lowerName.includes('эйфелев')) return photos.eiffel;
    if (lowerName.includes('everest') || lowerName.includes('himalaya') || lowerName.includes('эверест')) return photos.everest;
    if (lowerName.includes('venice') || lowerName.includes('venezia') || lowerName.includes('венеция')) return photos.venice;
    if (lowerName.includes('machu') || lowerName.includes('peru') || lowerName.includes('мачу')) return photos.machu;
    if (lowerName.includes('tokyo') || lowerName.includes('japan') || lowerName.includes('токио')) return photos.tokyo;
    if (lowerName.includes('york') || lowerName.includes('manhattan') || lowerName.includes('times square') || lowerName.includes('йорк')) return photos.new_york;
    if (lowerName.includes('gate') || lowerName.includes('francisco') || lowerName.includes('золотые ворота')) return photos.gold_gate;
    
    const categories = [
      'https://images.unsplash.com/photo-1501854140801-50d01698950b?auto=format&fit=crop&w=150&h=150&q=80',
      'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=150&h=150&q=80',
      'https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?auto=format&fit=crop&w=150&h=150&q=80',
      'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=150&h=150&q=80',
      'https://images.unsplash.com/photo-1472214222541-d510753a4707?auto=format&fit=crop&w=150&h=150&q=80',
      'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=150&h=150&q=80',
      'https://images.unsplash.com/photo-1513836279014-a89f7a76ae86?auto=format&fit=crop&w=150&h=150&q=80',
      'https://images.unsplash.com/photo-1433832597046-4f10e10ac764?auto=format&fit=crop&w=150&h=150&q=80',
      'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=150&h=150&q=80',
    ];
    
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % categories.length;
    return categories[index];
  }

  getBookmarkCategory(name: string): string {
    const lower = name.toLowerCase();
    
    // Mountains keywords
    if (
      lower.includes('mountain') || 
      lower.includes('mount ') || 
      lower.includes('mt.') || 
      lower.includes('mt ') || 
      lower.includes('peak') || 
      lower.includes('canyon') || 
      lower.includes('fuji') || 
      lower.includes('everest') || 
      lower.includes('hill') || 
      lower.includes('valley') || 
      lower.includes('volcano') || 
      lower.includes('ridge') || 
      lower.includes('range') ||
      lower.includes('machu picchu') ||
      lower.includes('alps') ||
      lower.includes('andes') ||
      lower.includes('rocky') ||
      lower.includes('вулкан') ||
      lower.includes('гора') ||
      lower.includes('каньон') ||
      lower.includes('эверест') ||
      lower.includes('фудзи')
    ) {
      return 'Mountains';
    }
    
    // Cities/Urban keywords
    if (
      lower.includes('city') || 
      lower.includes('town') || 
      lower.includes('tokyo') || 
      lower.includes('paris') || 
      lower.includes('rome') || 
      lower.includes('venice') || 
      lower.includes('york') || 
      lower.includes('london') || 
      lower.includes('chicago') || 
      lower.includes('sydney') || 
      lower.includes('san francisco') || 
      lower.includes('street') || 
      lower.includes('avenue') || 
      lower.includes('square') || 
      lower.includes('plaza') || 
      lower.includes('metro') || 
      lower.includes('downtown') ||
      lower.includes('vegas') ||
      lower.includes('dubai') ||
      lower.includes('город') ||
      lower.includes('улица') ||
      lower.includes('площадь') ||
      lower.includes('токио') ||
      lower.includes('париж') ||
      lower.includes('рим') ||
      lower.includes('венеция')
    ) {
      return 'Cities';
    }
    
    // Landmarks keywords
    if (
      lower.includes('statue') || 
      lower.includes('tower') || 
      lower.includes('colosseum') || 
      lower.includes('bridge') || 
      lower.includes('palace') || 
      lower.includes('castle') || 
      lower.includes('opera') || 
      lower.includes('temple') || 
      lower.includes('cathedral') || 
      lower.includes('church') || 
      lower.includes('monument') || 
      lower.includes('shrine') || 
      lower.includes('museum') || 
      lower.includes('memorial') || 
      lower.includes('pyramid') || 
      lower.includes('park') || 
      lower.includes('garden') || 
      lower.includes('gate') || 
      lower.includes('harbor') || 
      lower.includes('fort') ||
      lower.includes('stadium') ||
      lower.includes('arena') ||
      lower.includes('house') ||
      lower.includes('taj mahal') ||
      lower.includes('wall of china') ||
      lower.includes('статуя') ||
      lower.includes('башня') ||
      lower.includes('колизей') ||
      lower.includes('мост') ||
      lower.includes('дворец') ||
      lower.includes('замок') ||
      lower.includes('храм') ||
      lower.includes('музей')
    ) {
      return 'Landmarks';
    }

    return 'Other';
  }

  getCategoryEmoji(category: string): string {
    switch (category) {
      case 'Cities': return '🏙️';
      case 'Mountains': return '🏔️';
      case 'Landmarks': return '🏛️';
      default: return '📍';
    }
  }

  shareBookmark(b: {id: string, name: string, lat: number, lng: number, tilt: number, heading: number, range: number}) {
    const url = new URL(window.location.href);
    url.searchParams.set('lat', b.lat.toString());
    url.searchParams.set('lng', b.lng.toString());
    url.searchParams.set('tilt', b.tilt.toString());
    url.searchParams.set('heading', b.heading.toString());
    url.searchParams.set('range', b.range.toString());

    const shareUrl = url.toString();

    navigator.clipboard.writeText(shareUrl).then(() => {
      this.copiedBookmarkId = b.id;
      this.requestUpdate();
      setTimeout(() => {
        if (this.copiedBookmarkId === b.id) {
          this.copiedBookmarkId = '';
          this.requestUpdate();
        }
      }, 2000);
    }).catch(err => {
      console.error('Could not copy text: ', err);
    });
  }

  startEditingBookmark(id: string, currentName: string) {
    this.editingBookmarkId = id;
    this.editingBookmarkName = currentName;
    this.requestUpdate();
  }

  saveBookmarkName(id: string) {
    const trimmedName = this.editingBookmarkName.trim();
    if (trimmedName) {
      this.bookmarks = this.bookmarks.map(b => b.id === id ? { ...b, name: trimmedName } : b);
      this.saveBookmarksToStorage();
    }
    this.cancelEditingBookmark();
  }

  cancelEditingBookmark() {
    this.editingBookmarkId = '';
    this.editingBookmarkName = '';
    this.requestUpdate();
  }

  onNewBookmarkNameInput(e: Event) {
    this.newBookmarkName = (e.target as HTMLInputElement).value;
  }

  onManualSearchQueryInput(e: Event) {
    this.manualSearchQuery = (e.target as HTMLInputElement).value;
  }

  onManualSearch(e: Event) {
    e.preventDefault();
    if (this.manualSearchQuery.trim()) {
      const q = this.manualSearchQuery.trim();
      this.addRecentSearch(q);
      this._handleViewLocation(q);
    }
  }

  onManualOriginInput(e: Event) {
    this.manualOrigin = (e.target as HTMLInputElement).value;
  }

  onManualDestinationInput(e: Event) {
    this.manualDestination = (e.target as HTMLInputElement).value;
  }

  onManualDirections(e: Event) {
    e.preventDefault();
    if (this.manualOrigin.trim() && this.manualDestination.trim()) {
      this._handleDirections(this.manualOrigin.trim(), this.manualDestination.trim());
    }
  }

  onFlyDurationInput(e: Event) {
    this.flyDuration = Number((e.target as HTMLInputElement).value);
  }

  private orbitAnimationId?: number;

  toggleAutoOrbitOnLoad() {
    this.autoOrbitOnLoad = !this.autoOrbitOnLoad;
    try {
      localStorage.setItem('gdm_map_auto_orbit', String(this.autoOrbitOnLoad));
    } catch (e) {
      console.error(e);
    }
    // If we turned it off, clear any pending flyTo automatic orbit trigger
    if (!this.autoOrbitOnLoad && this.flyToTimeoutId !== undefined) {
      clearTimeout(this.flyToTimeoutId);
      this.flyToTimeoutId = undefined;
    }
    this.requestUpdate();
  }

  toggleOrbit() {
    if (this.flyToTimeoutId !== undefined) {
      clearTimeout(this.flyToTimeoutId);
      this.flyToTimeoutId = undefined;
    }
    this.isOrbiting = !this.isOrbiting;
    if (this.isOrbiting) {
      this._runOrbit();
    } else {
      if (this.orbitAnimationId !== undefined) {
        cancelAnimationFrame(this.orbitAnimationId);
        this.orbitAnimationId = undefined;
      }
    }
  }

  private _runOrbit() {
    if (!this.isOrbiting) return;
    if (this.mapInitialized && this.map) {
      let currentHeading = this.map.heading || 0;
      currentHeading = (currentHeading + 0.15) % 360;
      this.mapHeading = Math.round(currentHeading);
      this.map.heading = currentHeading;
    }
    this.orbitAnimationId = requestAnimationFrame(() => this._runOrbit());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.orbitAnimationId !== undefined) {
      cancelAnimationFrame(this.orbitAnimationId);
    }
    if (this.flyToTimeoutId !== undefined) {
      clearTimeout(this.flyToTimeoutId);
    }
  }

  onCompassReset() {
    this.mapHeading = 0;
    if (this.map) {
      this.map.heading = 0;
    }
  }

  toggleTiltMode() {
    const targetTilt = this.mapTilt === 0 ? 65 : 0;
    this.mapTilt = targetTilt;
    if (this.map) {
      this.map.tilt = targetTilt;
    }
  }

  zoomIn() {
    if (this.map) {
      const newRange = Math.max(100, Math.round(this.mapRange / 1.5));
      this.mapRange = newRange;
      this.map.range = newRange;
    }
  }

  zoomOut() {
    if (this.map) {
      const newRange = Math.min(10000000, Math.round(this.mapRange * 1.5));
      this.mapRange = newRange;
      this.map.range = newRange;
    }
  }

  addRecentSearch(query: string) {
    if (!query || !query.trim()) return;
    const cleanQuery = query.trim();
    let updated = this.recentSearches.filter(q => q.toLowerCase() !== cleanQuery.toLowerCase());
    updated.unshift(cleanQuery);
    if (updated.length > 5) {
      updated = updated.slice(0, 5);
    }
    this.recentSearches = updated;
    try {
      localStorage.setItem('gdm_map_recent_searches', JSON.stringify(updated));
    } catch (e) {
      console.error('Error saving recent searches', e);
    }
  }

  clearRecentSearches() {
    this.recentSearches = [];
    try {
      localStorage.removeItem('gdm_map_recent_searches');
    } catch (e) {
      console.error('Error clearing recent searches', e);
    }
  }

  onRecentSearchClick(query: string) {
    if (this.chatState !== ChatState.IDLE) return;
    this.sendMessageAction(query);
  }

  renderRecentSearches() {
    if (this.recentSearches.length === 0) {
      return html`
        <div class="recent-searches-container">
          <div class="recent-searches-header">
            <span>🔍 Recent Searches</span>
          </div>
          <div class="recent-searches-empty">
            Your search history is empty. Try asking for a scenic location!
          </div>
        </div>
      `;
    }

    return html`
      <div class="recent-searches-container">
        <div class="recent-searches-header">
          <span>🔍 Recent Searches</span>
          <button class="recent-searches-clear" @click=${this.clearRecentSearches} title="Clear history">
            Clear
          </button>
        </div>
        <div class="recent-searches-chips" role="group" aria-label="Recent Searches">
          ${this.recentSearches.map(q => html`
            <button 
              class="recent-search-chip" 
              ?disabled=${this.chatState !== ChatState.IDLE}
              @click=${() => this.onRecentSearchClick(q)}
              title="Search for '${q}'">
              <span class="chip-text">${q}</span>
            </button>
          `)}
        </div>
      </div>
    `;
  }

  renderMapHud() {
    // If map error exists, don't render controls
    if (this.mapError) return html``;

    const flightStatus = this.isOrbiting 
      ? 'Orbiting Target' 
      : (this.activeBookmarkId ? 'Scenic Flight' : 'Ready');

    const tiltLabel = this.mapTilt === 0 ? '2D Map View' : '3D Perspective';

    return html`
      <div class="map-hud-overlay-container">
        <!-- Top Bar with status indicators -->
        <div class="map-hud-top-bar">
          <div class="map-hud-pill-group">
            <div class="map-hud-pill">
              <span class="map-hud-pill-indicator active"></span>
              <span>3D Engine: Online</span>
            </div>
            <div class="map-hud-pill">
              <span class="map-hud-pill-indicator ${this.isOrbiting ? 'busy' : 'active'}"></span>
              <span>Status: ${flightStatus}</span>
            </div>
          </div>
        </div>

        <!-- Floating Controls Dock (centered right, independent) -->
        <div class="map-hud-controls-dock">
          <!-- Compass Reset Button -->
          <button 
            class="map-hud-btn" 
            @click=${this.onCompassReset}
            aria-label="Reset Compass to North">
            <div class="compass-icon-wrapper" style="transform: rotate(-${this.mapHeading}deg);">
              <!-- Beautiful Compass Icon -->
              <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
                <path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q134 0 227 93t93 227q0 134-93 227t-227 93Zm0-80q100 0 170-70t70-170q0-100-70-170t-170-70q-100 0-170 70t-70 170q0 100 70 170t170 70Zm-40-160 80-120 80 120H440ZM480-800q-17 0-28.5-11.5T440-840q0-17 11.5-28.5T480-880q17 0 28.5 11.5T520-840q0 17-11.5 28.5T480-800ZM120-480q-17 0-28.5-11.5T80-520q0-17 11.5-28.5T120-560q17 0 28.5 11.5T160-520q0 17-11.5 28.5T120-480Zm640 0q-17 0-28.5-11.5T720-520q0-17 11.5-28.5T760-560q17 0 28.5 11.5T800-520q0 17-11.5 28.5T760-480Zm-280 40q-17 0-28.5-11.5T440-480q0-17 11.5-28.5T480-520q17 0 28.5 11.5T520-480q0 17-11.5 28.5T480-440Z"/>
              </svg>
            </div>
            <span class="tooltip">Reset Compass (0°)</span>
          </button>

          <!-- 2D / 3D Perspective Toggle -->
          <button 
            class="map-hud-btn ${this.mapTilt > 0 ? 'active' : ''}" 
            @click=${this.toggleTiltMode}
            aria-label="Toggle 2D/3D Perspective">
            <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
              <path d="M120-160v-640h80v640h-80Zm240 0v-400h80v400h-80Zm240 0v-240h80v240h-80Zm240 0v-520h80v520h-80Z"/>
            </svg>
            <span class="tooltip">${tiltLabel}</span>
          </button>

          <!-- Orbit Spin Toggle -->
          <button 
            class="map-hud-btn ${this.isOrbiting ? 'active' : ''}" 
            @click=${this.toggleOrbit}
            aria-label="Toggle Automatic Orbit Rotation">
            <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
              <path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q134 0 227 93t93 227q0 134-93 227t-227 93Zm0-80q100 0 170-70t70-170q0-100-70-170t-170-70q-100 0-170 70t-70 170q0 100 70 170t170 70Zm0-120q-50 0-85-35t-35-85q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35Z"/>
            </svg>
            <span class="tooltip">${this.isOrbiting ? 'Stop Orbit Spin' : 'Orbit Target'}</span>
          </button>

          <!-- Zoom In -->
          <button 
            class="map-hud-btn" 
            @click=${this.zoomIn}
            aria-label="Zoom In">
            <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
              <path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z"/>
            </svg>
            <span class="tooltip">Zoom In</span>
          </button>

          <!-- Zoom Out -->
          <button 
            class="map-hud-btn" 
            @click=${this.zoomOut}
            aria-label="Zoom Out">
            <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
              <path d="M200-440v-80h560v80H200Z"/>
            </svg>
            <span class="tooltip">Zoom Out</span>
          </button>

          <!-- Toggle Live Weather Overlay -->
          <button 
            class="map-hud-btn ${this.showWeatherOverlay ? 'active' : ''}" 
            @click=${this.toggleWeatherOverlay}
            aria-label="Toggle Weather Overlay">
            <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
              <path d="M480-160q-133 0-226.5-93.5T160-480q0-104 57-185.5t153-111q11-17 28.5-27t38.5-13.5q-6 24-2 47.5t17 44.5L341-610q-37 17-60.5 50.5T257-480q0 93 65.5 158.5T481-256q42 0 79-15.5t65-42.5l57 57q-38 38-89.5 59.5T480-160Zm300-300q-58 0-99-41t-41-99q0-58 41-99t99-41q58 0 99 41t41 99q0 58-41 99t-99 41ZM581-540q-14-11-23.5-26.5T546-600l-51-16q-16 11-34.5 13.5T422-600l34-44q19 11 41 12.5t41-11.5l46 16q-5 18-3.5 35.5t12.5 31.5l-12 16ZM480-480Z"/>
            </svg>
            <span class="tooltip">${this.showWeatherOverlay ? 'Hide Weather' : 'Show Weather'}</span>
          </button>

          <!-- Toggle POI Overlay -->
          <button 
            class="map-hud-btn ${this.showPoiMarkers ? 'active' : ''}" 
            @click=${this.togglePoiMarkers}
            aria-label="Toggle POIs">
            <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
              <path d="M480-480q33 0 56.5-23.5T560-560q0-33-23.5-56.5T480-640q-33 0-56.5 23.5T400-560q0 33 23.5 56.5T480-480Zm0 294q122-112 181-203.5T720-552q0-109-75.5-183.5T480-810q-109 0-184.5 74.5T220-552q0 71 59 162.5T480-186Zm0 106Q319-215 239.5-329.5T160-552q0-150 100.5-249T480-900q162 0 261 98.5T840-552q0 138-79.5 252.5T480-80Zm0-472Z"/>
            </svg>
            <span class="tooltip">${this.showPoiMarkers ? 'Hide Attractions' : 'Show Attractions'}</span>
          </button>
        </div>

        <!-- Bottom Group (stacked coordinates and journey timeline) -->
        <div class="map-hud-bottom-group">
          <!-- Coordinates Row -->
          <div class="map-hud-bottom-row" style="display: flex; justify-content: flex-start; align-items: center; width: 100%; pointer-events: none;">
            <div class="map-hud-bottom-left" style="display: flex; gap: 8px; pointer-events: auto;">
              <div class="map-hud-pill">
                <span>🌐</span>
                <span>
                  ${this.centerLat.toFixed(4)}° ${this.centerLat >= 0 ? 'N' : 'S'}, 
                  ${Math.abs(this.centerLng).toFixed(4)}° ${this.centerLng >= 0 ? 'E' : 'W'}
                </span>
              </div>
              <div class="map-hud-pill">
                <span>📏</span>
                <span>Altitude: ${this.formatRange(this.mapRange)}</span>
              </div>
            </div>
          </div>

          ${this.renderTimeline()}
        </div>
      </div>
    `;
  }

  render() {
    // Google Maps: Initial camera parameters for the <gmp-map-3d> element.
    const initialCenter = '37.8199,-122.4783,0'; // SF Golden Gate

    return html`<div class="gdm-map-app">
      <div
        class="main-container"
        role="application"
        aria-label="Interactive Map Area">
        ${this.mapError
          ? html`<div
              class="map-error-message"
              role="alert"
              aria-live="assertive"
              >${this.mapError}</div
            >`
          : ''}
        <!-- Google Maps: The core 3D Map custom element -->
        <gmp-map-3d
          id="mapContainer"
          style="height: 100%; width: 100%;"
          aria-label="Google Photorealistic 3D Map Display"
          internal-usage-attribution-ids="gmp_aistudio_threedmapjsmcp_v0.1_showcase"
          role="application">
        </gmp-map-3d>
        ${this.renderWeatherCard()}
        ${this.renderMapHud()}
      </div>
      <div class="sidebar" role="complementary" aria-labelledby="chat-heading">
        <div class="selector" role="tablist" aria-label="Chat and Settings tabs">
          <button
            id="geminiTab"
            role="tab"
            aria-selected=${this.selectedChatTab === ChatTab.GEMINI}
            aria-controls="chat-panel"
            class=${classMap({
              'selected-tab': this.selectedChatTab === ChatTab.GEMINI,
            })}
            @click=${() => {
              this.selectedChatTab = ChatTab.GEMINI;
            }}>
            <!-- Chat Icon -->
            <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
              <path d="M240-400h320v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Zm126-240h594v-480H160v525l46-45Zm-46 0v-480 480Z"/>
            </svg>
            <span id="chat-heading">Chat</span>
          </button>
          <button
            id="settingsTab"
            role="tab"
            aria-selected=${this.selectedChatTab === ChatTab.SETTINGS}
            aria-controls="settings-panel"
            class=${classMap({
              'selected-tab': this.selectedChatTab === ChatTab.SETTINGS,
            })}
            @click=${() => {
              this.selectedChatTab = ChatTab.SETTINGS;
            }}>
            <!-- Gear Icon -->
            <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
              <path d="m370-80-16-128q-19-5-38.5-15.5T279-249l-119 50-80-138 102-78q-2-10-2-21t2-21l-102-78 80-138 119 50q17-15 36.5-25.5T354-800l16-128h160l16 128q19 5 38.5 15.5T681-711l119-50 80 138-102 78q2 10 2 21t-2 21l102 78-80 138-119-50q-17 15-36.5 25.5T606-160l-16 128H370Zm80-280q42 0 71-29t29-71q0-42-29-71t-71-29q-42 0-71 29t-29 71q0 42 29 71t71 29Zm-43-14q26 0 44.5-18.5T470-483q0-26-18.5-44.5T407-546q-26 0-44.5 18.5T344-483q0 26 18.5 44.5T364-420ZM400-480Z"/>
            </svg>
            <span>Settings</span>
          </button>
        </div>
        <div
          id="chat-panel"
          role="tabpanel"
          aria-labelledby="geminiTab"
          class=${classMap({
            'tabcontent': true,
            'showtab': this.selectedChatTab === ChatTab.GEMINI,
          })}>
          ${this.renderRecentSearches()}
          <div class="chat-messages" aria-live="polite" aria-atomic="false">
            ${this.messages}
            <div id="anchor"></div>
          </div>
          <div class="footer">
            <div
              id="chatStatus"
              aria-live="assertive"
              class=${classMap({'hidden': this.chatState === ChatState.IDLE})}>
              ${this.chatState === ChatState.GENERATING
                ? html`${ICON_BUSY} Generating...`
                : html``}
              ${this.chatState === ChatState.THINKING
                ? html`${ICON_BUSY} Thinking...`
                : html``}
              ${this.chatState === ChatState.EXECUTING
                ? html`${ICON_BUSY} Executing...`
                : html``}
            </div>
            <div
              id="inputArea"
              role="form"
              aria-labelledby="message-input-label">
              <label id="message-input-label" class="hidden"
                >Type your message</label
              >
              <input
                type="text"
                id="messageInput"
                .value=${this.inputMessage}
                @input=${(e: InputEvent) => {
                  this.inputMessage = (e.target as HTMLInputElement).value;
                }}
                @keydown=${(e: KeyboardEvent) => {
                  this.inputKeyDownAction(e);
                }}
                placeholder="Type your message..."
                autocomplete="off"
                aria-labelledby="message-input-label"
                aria-describedby="sendButton-desc" />
              <button
                id="sendButton"
                @click=${() => {
                  this.sendMessageAction();
                }}
                aria-label="Send message"
                aria-describedby="sendButton-desc"
                ?disabled=${this.chatState !== ChatState.IDLE}
                class=${classMap({
                  'disabled': this.chatState !== ChatState.IDLE,
                })}>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  height="30px"
                  viewBox="0 -960 960 960"
                  width="30px"
                  fill="currentColor"
                  aria-hidden="true">
                  <path d="M120-160v-240l320-80-320-80v-240l760 320-760 320Z" />
                </svg>
              </button>
              <p id="sendButton-desc" class="hidden"
                >Sends the typed message to the AI.</p
              >
            </div>
          </div>
        </div>

        <div
          id="settings-panel"
          role="tabpanel"
          aria-labelledby="settingsTab"
          class=${classMap({
            'tabcontent': true,
            'showtab': this.selectedChatTab === ChatTab.SETTINGS,
          })}>
          <div class="settings-container">
            <h3 class="settings-title">Interactive Map Tools</h3>

            <!-- Search & Flying Tools Section -->
            <div class="settings-section">
              <h4 class="section-label">🔍 Search Location (Fly-to)</h4>
              <form class="settings-form" @submit=${this.onManualSearch}>
                <div class="settings-input-group">
                  <input
                    type="text"
                    class="settings-input"
                    placeholder="Enter location (e.g. Eiffel Tower)..."
                    .value=${this.manualSearchQuery}
                    @input=${this.onManualSearchQueryInput} />
                  <button type="submit" class="settings-button">
                    <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
                      <path d="M784-120 532-372q-30 24-74 38t-90 14q-117 0-198.5-81.5T88-600q0-117 81.5-198.5T368-880q117 0 198.5 81.5T648-600q0 49-14 93t-38 75l252 252-64 64ZM368-292q70 0 119-49t49-119q0-70-49-119t-119-49q-70 0-119 49t-49 119q0 70 49 119t119 49Z"/>
                    </svg>
                    Fly
                  </button>
                </div>
              </form>
            </div>

            <!-- Route Builder Section -->
            <div class="settings-section">
              <h4 class="section-label">🛣️ Route & Directions Builder</h4>
              <form class="settings-form" @submit=${this.onManualDirections}>
                <input
                  type="text"
                  class="settings-input"
                  placeholder="Start from (e.g. Tokyo Tower)..."
                  .value=${this.manualOrigin}
                  @input=${this.onManualOriginInput} />
                <div class="settings-input-group">
                  <input
                    type="text"
                    class="settings-input"
                    placeholder="End at (e.g. Shibuya Crossing)..."
                    .value=${this.manualDestination}
                    @input=${this.onManualDestinationInput} />
                  <button type="submit" class="settings-button">
                    <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
                      <path d="M480-480q33 0 56.5-23.5T560-560q0-33-23.5-56.5T480-640q-33 0-56.5 23.5T400-560q0 33 23.5 56.5T480-480Zm0 294q122-112 181-203.5T720-552q0-109-75.5-183.5T480-810q-109 0-184.5 74.5T220-552q0 71 59 162.5T480-186Zm0 106Q319-215 239.5-329.5T160-552q0-150 100.5-249T480-900q162 0 261 98.5T840-552q0 138-79.5 252.5T480-80Zm0-472Z"/>
                    </svg>
                    Route
                  </button>
                </div>
              </form>
            </div>

            <!-- Scenic Flight Options -->
            <div class="settings-section">
              <h4 class="section-label">🎬 Fly-to & Animation Effects</h4>
              <div style="display: flex; flex-direction: column; gap: 10px;">
                <button 
                  class="settings-button ${this.isOrbiting ? 'active-orbit' : 'outline'}" 
                  style="width: 100%;"
                  @click=${this.toggleOrbit}>
                  <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
                    <path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q134 0 227 93t93 227q0 134-93 227t-227 93Zm0-80q100 0 170-70t70-170q0-100-70-170t-170-70q-100 0-170 70t-70 170q0 100 70 170t170 70Zm0-120q-50 0-85-35t-35-85q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35Z"/>
                  </svg>
                  ${this.isOrbiting ? 'Stop Orbiting' : 'Orbit Target (Spin)'}
                </button>
                <div class="checkbox-container">
                  <input 
                    type="checkbox" 
                    id="autoOrbitToggle"
                    ?checked=${this.autoOrbitOnLoad}
                    @change=${this.toggleAutoOrbitOnLoad} />
                  <label for="autoOrbitToggle">🔄 Auto-orbit on bookmark load</label>
                </div>
              </div>
            </div>

            <!-- Flight Animation Speed -->
            <div class="settings-section">
              <div class="slider-header">
                <h4 class="section-label">⚡ Flight Duration</h4>
                <span class="value-display">${(this.flyDuration / 1000).toFixed(1)}s</span>
              </div>
              <input
                type="range"
                class="settings-slider"
                min="500"
                max="10000"
                step="500"
                .value=${this.flyDuration}
                @input=${this.onFlyDurationInput} />
              <div class="slider-ticks">
                <span>Fast (0.5s)</span>
                <span>Scenic (10s)</span>
              </div>
            </div>

            <!-- Auto-save Bookmarks Section -->
            <div class="settings-section">
              <div class="slider-header" style="margin-bottom: 6px;">
                <h4 class="section-label">📸 Auto-save Bookmarks</h4>
              </div>
              <div class="checkbox-container" style="margin-bottom: 8px;">
                <input 
                  type="checkbox" 
                  id="autoSaveBookmarkToggle"
                  ?checked=${this.autoSaveBookmarkEnabled}
                  @change=${this.toggleAutoSaveBookmark} />
                <label for="autoSaveBookmarkToggle" style="display: flex; align-items: center; gap: 4px;">Enable auto-save on idle</label>
              </div>
              <p style="font-size: 11px; color: var(--color-text-secondary, #888); margin-bottom: 12px; line-height: 1.4;">
                Automatically creates a bookmark of the current map view when it remains static/idle for a specified number of seconds.
              </p>
              
              ${this.autoSaveBookmarkEnabled ? html`
                <div class="slider-container" style="margin-top: 8px;">
                  <div class="slider-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <span style="font-size: 11px; font-weight: 500; color: var(--color-text2);">Idle Duration Delay</span>
                    <span class="value-display" style="font-size: 11px; font-weight: 600; color: var(--color-accent);">${this.autoSaveBookmarkDelay} seconds</span>
                  </div>
                  <input
                    type="range"
                    class="settings-slider"
                    min="2"
                    max="15"
                    step="1"
                    .value=${this.autoSaveBookmarkDelay}
                    @input=${(e: any) => this.changeAutoSaveDelay(parseInt(e.target.value, 10))} />
                  <div class="slider-ticks" style="display: flex; justify-content: space-between; font-size: 10px; color: var(--color-text-secondary, #888); margin-top: 2px;">
                    <span>Fast (2s)</span>
                    <span>Relaxed (15s)</span>
                  </div>
                </div>
              ` : ''}
            </div>

            <!-- Journey Timeline Section -->
            <div class="settings-section">
              <div class="slider-header" style="margin-bottom: 6px;">
                <h4 class="section-label">🗺️ Journey Timeline</h4>
              </div>
              <div class="checkbox-container">
                <input 
                  type="checkbox" 
                  id="timelineVisibilityToggle"
                  ?checked=${this.timelineVisible}
                  @change=${this.toggleTimelineVisibility} />
                <label for="timelineVisibilityToggle" style="display: flex; align-items: center; gap: 4px;">Show horizontal timeline</label>
              </div>
              <p style="font-size: 11px; color: var(--color-text-secondary, #888); margin-top: 6px; line-height: 1.4;">
                Visualizes the historical sequence of your saved locations at the bottom of the map for quick access and scrolling.
              </p>
            </div>

            <!-- Bookmarks Section -->
            <div class="settings-section">
              <h4 class="section-label">📌 Saved Bookmarks</h4>
              <div class="bookmark-creator" style="margin-bottom: 12px; margin-top: 8px;">
                <div class="settings-input-group">
                  <input
                    type="text"
                    id="bookmarkNameInput"
                    class="settings-input"
                    style="flex: 1;"
                    placeholder="Name (optional, auto-geocodes)..."
                    .value=${this.newBookmarkName}
                    @input=${this.onNewBookmarkNameInput} />
                  <button 
                    class="settings-button" 
                    ?disabled=${this.bookmarkIsSaving}
                    @click=${this.saveCurrentAsBookmark}
                    style="flex-shrink: 0;">
                    ${this.bookmarkIsSaving ? 'Saving...' : 'Save View'}
                  </button>
                </div>
              </div>

              ${(() => {
                let displayBookmarks = [...this.bookmarks];
                if (this.selectedCategoryFilter === 'Sort') {
                  displayBookmarks.sort((a, b) => {
                    const catA = this.getBookmarkCategory(a.name);
                    const catB = this.getBookmarkCategory(b.name);
                    if (catA !== catB) {
                      return catA.localeCompare(catB);
                    }
                    return a.name.localeCompare(b.name);
                  });
                } else if (this.selectedCategoryFilter !== 'All') {
                  displayBookmarks = displayBookmarks.filter(b => this.getBookmarkCategory(b.name) === this.selectedCategoryFilter);
                }

                return html`
                  <div class="category-filter-container" style="margin-bottom: 12px; margin-top: 4px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                    <span style="font-size: 0.72rem; font-weight: 600; color: var(--color-text3);">Filter & Sort:</span>
                    <select 
                      class="category-filter-select"
                      style="flex: 1; max-width: 165px;"
                      @change=${(e: any) => { this.selectedCategoryFilter = e.target.value; this.requestUpdate(); }}
                      .value=${this.selectedCategoryFilter}>
                      <option value="All">📁 All (Unsorted)</option>
                      <option value="Sort">🔀 All (Sorted by Category)</option>
                      <option value="Cities">🏙️ Cities</option>
                      <option value="Mountains">🏔️ Mountains</option>
                      <option value="Landmarks">🏛️ Landmarks</option>
                      <option value="Other">📍 Other</option>
                    </select>
                  </div>

                  ${this.bookmarks.length === 0 ? html`
                    <div class="bookmarks-empty-state">
                      No saved bookmarks yet. Pan the map and click "Save View" to add one!
                    </div>
                  ` : displayBookmarks.length === 0 ? html`
                    <div class="bookmarks-empty-state">
                      No saved bookmarks in this category.
                    </div>
                  ` : html`
                    <div class="bookmarks-list">
                      ${displayBookmarks.map((b, index) => {
                        const category = this.getBookmarkCategory(b.name);
                        const emoji = this.getCategoryEmoji(category);
                        return html`
                          <div class="bookmark-item ${this.activeBookmarkId === b.id ? 'active' : ''}" id="bookmark-${b.id}" style="--stagger-delay: ${index * 60}ms;">
                            ${this.editingBookmarkId === b.id ? html`
                              <div class="bookmark-item-editing-form">
                                 <input 
                                  type="text" 
                                  class="bookmark-edit-input" 
                                  .value=${this.editingBookmarkName} 
                                  @input=${(e: any) => this.editingBookmarkName = e.target.value}
                                  @keydown=${(e: KeyboardEvent) => {
                                    if (e.key === 'Enter') this.saveBookmarkName(b.id);
                                    if (e.key === 'Escape') this.cancelEditingBookmark();
                                  }}
                                  @click=${(e: Event) => e.stopPropagation()}
                                  autofocus
                                />
                                <button class="bookmark-edit-save-btn" title="Save changes" @click=${() => this.saveBookmarkName(b.id)}>
                                  <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
                                    <path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/>
                                  </svg>
                                </button>
                                <button class="bookmark-edit-cancel-btn" title="Cancel" @click=${() => this.cancelEditingBookmark()}>
                                  <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
                                    <path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/>
                                  </svg>
                                </button>
                              </div>
                            ` : html`
                              <div class="bookmark-item-image-wrapper" @click=${() => this.flyTo(b.lat, b.lng, b.tilt, b.heading, b.range, b.id)}>
                                <img class="bookmark-item-image" src="${this.getBookmarkPhoto(b.name, b.id)}" alt="${b.name}" loading="lazy" />
                                <div class="bookmark-item-image-badge">
                                  <svg xmlns="http://www.w3.org/2000/svg" height="10px" viewBox="0 -960 960 960" width="10px" fill="currentColor">
                                    <path d="M120-160v-640l760 320-760 320Zm80-120 474-200-474-200v134l240 66-240 66v134Z"/>
                                  </svg>
                                  FLY
                                </div>
                              </div>
                              <div class="bookmark-item-clickable" @click=${() => this.flyTo(b.lat, b.lng, b.tilt, b.heading, b.range, b.id)}>
                                <span class="bookmark-item-name" title="${b.name}">${b.name}</span>
                                <span class="bookmark-item-coordinates">
                                  <span class="coordinate-badge">lat: ${b.lat.toFixed(4)}°</span>
                                  <span class="coordinate-badge">lng: ${b.lng.toFixed(4)}°</span>
                                  <span class="category-badge ${category.toLowerCase()}">${emoji} ${category}</span>
                                </span>
                                <span class="bookmark-item-meta-details">
                                  Tilt: ${b.tilt}° · Head: ${b.heading}° · ${Math.round(b.range)}m
                                </span>
                              </div>
                              <div class="bookmark-item-actions">
                                <button 
                                  class="bookmark-action-btn edit-btn"
                                  title="Rename bookmark"
                                  aria-label="Rename bookmark"
                                  @click=${() => this.startEditingBookmark(b.id, b.name)}>
                                  <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                                    <path d="M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z"/>
                                  </svg>
                                </button>
                                <button 
                                  class="bookmark-action-btn share-btn ${this.copiedBookmarkId === b.id ? 'copied' : ''}" 
                                  title="${this.copiedBookmarkId === b.id ? 'Copied!' : 'Copy Shareable Link'}"
                                  aria-label="Share bookmark" 
                                  @click=${() => this.shareBookmark(b)}>
                                  ${this.copiedBookmarkId === b.id ? html`
                                    <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                                      <path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/>
                                    </svg>
                                  ` : html`
                                    <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                                      <path d="M720-80q-50 0-85-35t-35-85q0-7 1-14.5t3-13.5L322-392q-17 15-38 23.5t-44 8.5q-50 0-85-35t-35-85q0-50 35-85t85-35q23 0 44 8.5t38 23.5l279-164q-2-6-3-13.5t-1-14.5q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35q-23 0-44-8.5T638-568L359-404q2 6 3 13.5t1 14.5q0 7-1 14.5t-3 13.5l279 164q17-15 38-23.5t44-8.5q50 0 85 35t35 85q0 50-35 85t-85 35Zm0-560q17 0 28.5-11.5T760-680q0-17-11.5-28.5T720-720q-17 0-28.5 11.5T680-680q0 17 11.5 28.5T720-640ZM240-440q17 0 28.5-11.5T280-480q0-17-11.5-28.5T240-520q-17 0-28.5 11.5T200-480q0 17 11.5 28.5T240-440Zm480 280q17 0 28.5-11.5T760-200q0-17-11.5-28.5T720-240q-17 0-28.5 11.5T680-200q0 17 11.5 28.5T720-160Z"/>
                                    </svg>
                                  `}
                                </button>
                                <button 
                                  class="bookmark-action-btn delete-btn" 
                                  aria-label="Delete bookmark" 
                                  @click=${() => this.deleteBookmark(b.id)}>
                                  <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                                    <path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v500h400v-500ZM360-220h80v-380h-80v380Zm160 0h80v-380h-80v380ZM280-720v500-500Z"/>
                                  </svg>
                                </button>
                              </div>
                            `}
                          </div>
                        `;
                      })}
                    </div>
                  `}
                `;
              })()}
            </div>

            <!-- Presets Section -->
            <div class="settings-section">
              <h4 class="section-label">🎯 Landmark Presets</h4>
              <div class="presets-grid">
                <button class="preset-btn" @click=${() => this.flyTo(36.0544, -112.1401, 60, 45, 4000)}>
                  🏔️ Grand Canyon
                </button>
                <button class="preset-btn" @click=${() => this.flyTo(48.8584, 2.2945, 75, 120, 800)}>
                  🗼 Eiffel Tower
                </button>
                <button class="preset-btn" @click=${() => this.flyTo(27.9881, 86.9250, 65, 200, 8000)}>
                  🏔️ Mt. Everest
                </button>
                <button class="preset-btn" @click=${() => this.flyTo(45.4408, 12.3155, 60, 0, 1500)}>
                  🛶 Venice, Italy
                </button>
                <button class="preset-btn" @click=${() => this.flyTo(-13.1631, -72.5450, 65, 30, 2000)}>
                  ⛰️ Machu Picchu
                </button>
                <button class="preset-btn" @click=${() => this.flyTo(35.6586, 139.7454, 70, 180, 1000)}>
                  🗼 Tokyo Tower
                </button>
                <button class="preset-btn" @click=${() => this.flyTo(40.7580, -73.9855, 70, 330, 1500)}>
                  🏙️ Times Square
                </button>
                <button class="preset-btn" @click=${() => this.flyTo(37.8199, -122.4783, 65, 230, 2500)}>
                  🌁 Golden Gate
                </button>
              </div>
            </div>

            <!-- Map Mode -->
            <div class="settings-section">
              <h4 class="section-label">🗺️ Map Style</h4>
              <div class="toggle-group">
                <button 
                  class="toggle-btn ${this.mapMode === 'hybrid' ? 'active' : ''}" 
                  @click=${() => this.onModeChange('hybrid')}>
                  Hybrid
                </button>
                <button 
                  class="toggle-btn ${this.mapMode === 'satellite' ? 'active' : ''}" 
                  @click=${() => this.onModeChange('satellite')}>
                  Satellite
                </button>
              </div>
            </div>

            <!-- Camera Heading -->
            <div class="settings-section">
              <div class="slider-header">
                <h4 class="section-label">🔄 Heading (Rotation)</h4>
                <span class="value-display">${this.mapHeading}°</span>
              </div>
              <input
                type="range"
                class="settings-slider"
                min="0"
                max="360"
                .value=${this.mapHeading}
                @input=${this.onHeadingInput} />
              <div class="slider-ticks">
                <span>N (0°)</span>
                <span>E (90°)</span>
                <span>S (180°)</span>
                <span>W (270°)</span>
              </div>
            </div>

            <!-- Camera Tilt -->
            <div class="settings-section">
              <div class="slider-header">
                <h4 class="section-label">📐 Tilt (Angle)</h4>
                <span class="value-display">${this.mapTilt}°</span>
              </div>
              <input
                type="range"
                class="settings-slider"
                min="0"
                max="90"
                .value=${this.mapTilt}
                @input=${this.onTiltInput} />
              <div class="slider-ticks">
                <span>Top-down</span>
                <span>Horizon</span>
              </div>
            </div>

            <!-- Camera Range -->
            <div class="settings-section">
              <div class="slider-header">
                <h4 class="section-label">🔍 Zoom Range</h4>
                <span class="value-display">${this.formatRange(this.mapRange)}</span>
              </div>
              <input
                type="range"
                class="settings-slider"
                min="100"
                max="10000000"
                step="100"
                .value=${this.mapRange}
                @input=${this.onRangeInput} />
              <div class="slider-ticks">
                <span>100 m</span>
                <span>10k km</span>
              </div>
            </div>

            <!-- Application Theme -->
            <div class="settings-section">
              <h4 class="section-label">🌗 Application Theme</h4>
              <div class="toggle-group" style="margin-top: 8px;">
                <button 
                  class="toggle-btn ${this.appTheme === 'light' ? 'active' : ''}" 
                  @click=${() => this.setAppTheme('light')}>
                  ☀️ Light Mode
                </button>
                <button 
                  class="toggle-btn ${this.appTheme === 'dark' ? 'active' : ''}" 
                  @click=${() => this.setAppTheme('dark')}>
                  🌙 Dark Mode
                </button>
              </div>
            </div>

            <!-- UI Controls -->
            <div class="settings-section">
              <div class="checkbox-container">
                <input 
                  type="checkbox" 
                  id="defaultUiToggle"
                  ?checked=${!this.defaultUiDisabled}
                  @change=${this.onDefaultUiChange} />
                <label for="defaultUiToggle">Show Navigation HUD</label>
              </div>
            </div>

            <!-- Weather Overlay Toggle -->
            <div class="settings-section">
              <div class="checkbox-container">
                <input 
                  type="checkbox" 
                  id="weatherOverlayToggle"
                  ?checked=${this.showWeatherOverlay}
                  @change=${this.toggleWeatherOverlay} />
                <label for="weatherOverlayToggle">⚡ Enable Live Weather Overlay</label>
              </div>
            </div>

            <!-- POI Overlay Toggle -->
            <div class="settings-section">
              <div class="checkbox-container">
                <input 
                  type="checkbox" 
                  id="poiToggle"
                  ?checked=${this.showPoiMarkers}
                  @change=${this.togglePoiMarkers} />
                <label for="poiToggle">📍 Show Nearby Points of Interest</label>
              </div>
              
              ${this.showPoiMarkers ? html`
                <div style="margin-top: 10px; padding-left: 24px;">
                  <div class="slider-header" style="margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 0.8rem; color: var(--color-text2);">Search Radius</span>
                    <span class="value-display" style="font-size: 0.8rem; font-weight: 600; color: var(--color-accent);">${this.poiSearchRadius}m</span>
                  </div>
                  <input
                    type="range"
                    class="settings-slider"
                    min="500"
                    max="5000"
                    step="100"
                    .value=${this.poiSearchRadius}
                    @input=${this.onPoiRadiusInput}
                    @change=${this.onPoiRadiusChange} />
                  <div class="slider-ticks" style="margin-top: 2px;">
                    <span>500m</span>
                    <span>2.5km</span>
                    <span>5km</span>
                  </div>
                </div>
              ` : ''}

              ${this.poiLoading ? html`<div style="font-size: 0.75rem; color: var(--color-text3); margin-top: 8px; padding-left: 24px;">Finding POIs...</div>` : ''}
            </div>

          </div>
        </div>
      </div>
    </div>`;
  }
}
