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
import {customElement, query, state, property} from 'lit/decorators.js';
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
  MCP_SERVER,
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
 * Custom web component for rendering bookmark cards.
 */
@customElement('bookmark-card')
export class BookmarkCard extends LitElement {
  @property({ type: Object }) bookmark: any = null;
  @property({ type: Boolean }) isActive = false;
  @property({ type: Boolean }) isEditing = false;
  @property({ type: String }) editingName = '';
  @property({ type: Boolean }) isNewlyAdded = false;
  @property({ type: Boolean }) isLoadingPhoto = false;
  @property({ type: String }) category = '';
  @property({ type: String }) emoji = '';
  @property({ type: Number }) index = 0;

  createRenderRoot() {
    return this; // Light DOM so existing theme styling applies automatically
  }

  getPhotoSrc(): string {
    const b = this.bookmark;
    if (b && b.photoUrl) {
      return b.photoUrl;
    }
    const name = (b && b.name) || '';
    const lowerName = name.toLowerCase();
    
    const photos: Record<string, string> = {
      grand_canyon: 'https://images.unsplash.com/photo-1615551043360-33de8b5f410c?auto=format&fit=crop&w=150&h=150&q=80',
      eiffel: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?auto=format&fit=crop&w=150&h=150&q=80',
      everest: 'https://images.unsplash.com/photo-1544735716-392fe2489ffa?auto=format&fit=crop&w=150&h=150&q=80',
      venice: 'https://images.unsplash.com/photo-1527631746610-bca00a040d60?auto=format&fit=crop&w=150&h=150&q=80',
      machu: 'https://images.unsplash.com/photo-1587595431973-160d0d94adb1?auto=format&fit=crop&w=150&h=150&q=80',
      tokyo: 'https://images.unsplash.com/photo-1503899036084-c55cdd92da26?auto=format&fit=crop&w=150&h=150&q=80',
      new_york: 'https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?auto=format&fit=crop&w=150&h=150&q=80',
    };

    for (const [key, url] of Object.entries(photos)) {
      if (lowerName.includes(key.replace('_', ' '))) {
        return url;
      }
    }
    return 'https://images.unsplash.com/photo-1524661135-423995f22d0b?auto=format&fit=crop&w=150&h=150&q=80';
  }

  render() {
    const b = this.bookmark;
    if (!b) return html``;
    const category = this.category;
    const emoji = this.emoji;

    return html`
      ${this.isEditing ? html`
        <div class="bookmark-item-editing-form" style="width: 100%; display: flex; gap: 4px; align-items: center;">
          <input 
            type="text" 
            class="bookmark-edit-input" 
            style="flex: 1; min-width: 0;"
            .value=${this.editingName} 
            @input=${(e: any) => {
              this.editingName = e.target.value;
              this.dispatchEvent(new CustomEvent('name-input', { detail: { value: e.target.value } }));
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                this.dispatchEvent(new CustomEvent('save-edit', { detail: { id: b.id, name: this.editingName } }));
              }
              if (e.key === 'Escape') {
                this.dispatchEvent(new CustomEvent('cancel-edit'));
              }
            }}
            @click=${(e: Event) => e.stopPropagation()}
            autofocus
          />
          <button class="bookmark-edit-save-btn" title="Save changes" @click=${(e: Event) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('save-edit', { detail: { id: b.id, name: this.editingName } }));
          }}>
            <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
              <path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/>
            </svg>
          </button>
          <button class="bookmark-edit-cancel-btn" title="Cancel" @click=${(e: Event) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('cancel-edit'));
          }}>
            <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
              <path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/>
            </svg>
          </button>
        </div>
      ` : html`
        <div class="bookmark-drag-handle" title="Drag to reorder" @mousedown=${(e: Event) => e.stopPropagation()}>
          <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
            <path d="M360-240q-25 0-42.5-17.5T300-300q0-25 17.5-42.5T360-360q25 0 42.5 17.5T420-300q0-25-17.5-42.5T360-240Zm240 0q-25 0-42.5-17.5T500-300q0-25 17.5-42.5T600-360q25 0 42.5 17.5T660-300q0-25-17.5-42.5T600-240Zm-240-180q-25 0-42.5-17.5T300-480q0-25 17.5-42.5T360-540q25 0 42.5 17.5T420-480q0-25-17.5-42.5T360-420Zm240 0q-25 0-42.5-17.5T500-480q0-25 17.5-42.5T600-540q25 0 42.5 17.5T660-480q0-25-17.5-42.5T600-420Zm-240-180q-25 0-42.5-17.5T300-660q0-25 17.5-42.5T360-720q25 0 42.5 17.5T420-660q0-25-17.5-42.5T360-600Zm240 0q-25 0-42.5-17.5T500-660q0-25 17.5-42.5T600-720q25 0 42.5 17.5T660-660q0-25-17.5-42.5T600-600Z"/>
          </svg>
        </div>
        <div class="bookmark-item-image-wrapper" @click=${() => this.dispatchEvent(new CustomEvent('fly-to', { detail: { id: b.id } }))}>
          <img class="bookmark-item-image" src="${this.getPhotoSrc()}" alt="${b.name}" loading="lazy" />
          <div class="bookmark-item-category-icon ${category.toLowerCase()}" title="${category}">
            ${emoji}
          </div>
          <div class="bookmark-item-image-badge">
            <svg xmlns="http://www.w3.org/2000/svg" height="10px" viewBox="0 -960 960 960" width="10px" fill="currentColor">
              <path d="M120-160v-640l760 320-760 320Zm80-120 474-200-474-200v134l240 66-240 66v134Z"/>
            </svg>
            FLY
          </div>
        </div>
        <div class="bookmark-item-clickable" @click=${() => this.dispatchEvent(new CustomEvent('fly-to', { detail: { id: b.id } }))}>
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
            @click=${(e: Event) => {
              e.stopPropagation();
              this.dispatchEvent(new CustomEvent('start-edit', { detail: { id: b.id, name: b.name } }));
            }}>
            <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
              <path d="M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z"/>
            </svg>
          </button>
          <button 
            class="bookmark-action-btn share-btn" 
            title="Copy Shareable Link"
            aria-label="Share bookmark" 
            @click=${(e: Event) => {
              e.stopPropagation();
              this.dispatchEvent(new CustomEvent('share', { detail: { bookmark: b } }));
            }}>
            <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
              <path d="M720-80q-50 0-85-35t-35-85q0-7 1-14.5t3-13.5L322-392q-17 15-38 23.5t-44 8.5q-50 0-85-35t-35-85q0-50 35-85t85-35q23 0 44 8.5t38 23.5l279-164q-2-6-3-13.5t-1-14.5q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35q-23 0-44-8.5T638-568L359-404q2 6 3 13.5t1 14.5q0 7-1 14.5t-3 13.5l279 164q17-15 38-23.5t44-8.5q50 0 85 35t35 85q0 50-35 85t-85 35Zm0-560q17 0 28.5-11.5T760-680q0-17-11.5-28.5T720-720q-17 0-28.5 11.5T680-680q0 17 11.5 28.5T720-640ZM240-440q17 0 28.5-11.5T280-480q0-17-11.5-28.5T240-520q-17 0-28.5 11.5T200-480q0 17 11.5 28.5T240-440Zm480 280q17 0 28.5-11.5T760-200q0-17-11.5-28.5T720-240q-17 0-28.5 11.5T680-200q0 17 11.5 28.5T720-160Z"/>
            </svg>
          </button>
          <button 
            class="bookmark-action-btn photo-btn ${this.isLoadingPhoto ? 'loading' : ''}" 
            title="Fetch/Refresh real-world Place Photo"
            aria-label="Fetch photo" 
            @click=${(e: Event) => {
              e.stopPropagation();
              this.dispatchEvent(new CustomEvent('fetch-photo', { detail: { id: b.id } }));
            }}
            ?disabled=${this.isLoadingPhoto}>
            ${this.isLoadingPhoto ? html`
              <svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                <path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q24 0 47.5 4t43.5 12l-64 64q-13-4-27-6t-27-2q-100 0-170 70t-70 170q0 100 70 170t170 70q100 0 170-70t70-170q0-14-2-27.5t-6-26.5l64-64q14 26 21 54t7 58q0 134-93 227T480-160Z"/>
              </svg>
            ` : html`
              <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                <path d="M720-640H580l-60-80H280v560h440V-640Zm0-80q33 0 56.5 23.5T800-640v480q0 33-23.5 56.5T720-80H280q-33 0-56.5-23.5T200-160v-560q0-33 23.5-56.5T280-800h160l60 80h220ZM360-320h240l-70-100-50 70-40-50-80 80ZM280-720v560-560Z"/>
              </svg>
            `}
          </button>
          <button 
            class="bookmark-action-btn delete-btn" 
            aria-label="Delete bookmark" 
            @click=${(e: Event) => {
              e.stopPropagation();
              this.dispatchEvent(new CustomEvent('delete', { detail: { id: b.id } }));
            }}>
            <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
              <path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v500h400v-500ZM360-220h80v-380h-80v380Zm160 0h80v-380h-80v380ZM280-720v500-500Z"/>
            </svg>
          </button>
        </div>
      `}
    `;
  }
}

/**
 * Custom web component for rendering the weather overlay card.
 */
@customElement('weather-overlay-card')
export class WeatherOverlayCard extends LitElement {
  @property({ type: Object }) weatherData: any = null;
  @property({ type: Boolean }) weatherLoading = false;
  @property({ type: String }) weatherError = '';
  @property({ type: String }) weatherUnit = 'C';
  @property({ type: Boolean }) showWeatherForecast = false;

  createRenderRoot() {
    return this; // Light DOM for styling integration
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

  renderWeatherEffects(bgClass: string) {
    switch (bgClass) {
      case 'weather-clear':
        return html`<div class="weather-effect-clear-flare"></div>`;
      case 'weather-cloudy':
        return html`
          <div class="weather-effect-cloud cloud-1"></div>
          <div class="weather-effect-cloud cloud-2"></div>
        `;
      case 'weather-rainy':
        return html`
          <div class="weather-effect-rain-drop drop-1"></div>
          <div class="weather-effect-rain-drop drop-2"></div>
          <div class="weather-effect-rain-drop drop-3"></div>
          <div class="weather-effect-rain-drop drop-4"></div>
          <div class="weather-effect-rain-drop drop-5"></div>
        `;
      case 'weather-snowy':
        return html`
          <div class="weather-effect-snow-flake flake-1">❄</div>
          <div class="weather-effect-snow-flake flake-2">❄</div>
          <div class="weather-effect-snow-flake flake-3">❄</div>
          <div class="weather-effect-snow-flake flake-4">❄</div>
          <div class="weather-effect-snow-flake flake-5">❄</div>
        `;
      case 'weather-stormy':
        return html`
          <div class="weather-effect-lightning-flash"></div>
          <div class="weather-effect-rain-drop drop-1"></div>
          <div class="weather-effect-rain-drop drop-2"></div>
          <div class="weather-effect-rain-drop drop-3"></div>
          <div class="weather-effect-rain-drop drop-4"></div>
        `;
      case 'weather-fog':
        return html`
          <div class="weather-effect-fog-mist mist-1"></div>
          <div class="weather-effect-fog-mist mist-2"></div>
        `;
      default:
        return html``;
    }
  }

  render() {
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
          <button class="weather-retry-btn" @click=${() => this.dispatchEvent(new CustomEvent('retry-weather'))}>Retry</button>
        </div>
      `;
    }

    if (!this.weatherData) {
      return html``;
    }

    const { temperature, windspeed, weathercode, lat, lng, forecast } = this.weatherData;
    const weatherInfo = this.getWeatherInfo(weathercode);
    const displayTemp = this.weatherUnit === 'F'
      ? `${((temperature * 9 / 5) + 32).toFixed(1)}°F`
      : `${temperature}°C`;

    return html`
      <div class="weather-overlay-card ${weatherInfo.bgClass}">
        <div class="weather-effects-container">
          ${this.renderWeatherEffects(weatherInfo.bgClass)}
        </div>
        <div class="weather-card-header">
          <div class="weather-loc-details">
            <span class="weather-title">Center Weather</span>
            <span class="weather-coords">${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E</span>
          </div>
          <span 
            class="weather-main-icon" 
            @click=${() => this.dispatchEvent(new CustomEvent('toggle-forecast'))} 
            title="${this.showWeatherForecast ? 'Hide 3-day forecast' : 'Show 3-day forecast'}">
            ${weatherInfo.icon}
          </span>
        </div>
        
        <div class="weather-temp-row">
          <span class="weather-temp-val">${displayTemp}</span>
          <span class="weather-unit-badge" style="cursor: pointer;" @click=${() => this.dispatchEvent(new CustomEvent('toggle-unit'))}>
            ${this.weatherUnit === 'F' ? 'Fahrenheit' : 'Celsius'}
          </span>
          <span class="weather-desc" style="margin-left: auto;">${weatherInfo.label}</span>
        </div>

        <div class="weather-stats-grid">
          <div class="weather-stat-item">
            <span class="weather-stat-icon">💨</span>
            <div class="weather-stat-info">
              <span class="weather-stat-lbl">Wind</span>
              <span class="weather-stat-val">${windspeed} km/h</span>
            </div>
          </div>
          <div class="weather-stat-item" style="cursor: pointer;" @click=${() => this.dispatchEvent(new CustomEvent('toggle-unit'))}>
            <span class="weather-stat-icon">🔄</span>
            <div class="weather-stat-info">
              <span class="weather-stat-lbl">Scale</span>
              <span class="weather-stat-val">Switch to °${this.weatherUnit === 'F' ? 'C' : 'F'}</span>
            </div>
          </div>
        </div>

        ${this.showWeatherForecast && forecast && forecast.length > 0 ? html`
          <div class="weather-forecast-section animate-fade-in" style="margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.15); padding-top: 10px;">
            <div style="font-size: 0.72rem; font-weight: 700; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.9;">3-Day Forecast</div>
            <div style="display: flex; gap: 8px; justify-content: space-between;">
              ${forecast.map((day: any) => {
                const dayInfo = this.getWeatherInfo(day.weathercode);
                const maxT = this.weatherUnit === 'F' ? `${((day.tempMax * 9 / 5) + 32).toFixed(0)}°` : `${day.tempMax.toFixed(0)}°`;
                const minT = this.weatherUnit === 'F' ? `${((day.tempMin * 9 / 5) + 32).toFixed(0)}°` : `${day.tempMin.toFixed(0)}°`;
                const weekday = new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' });
                return html`
                  <div style="flex: 1; background: rgba(0,0,0,0.25); padding: 6px; border-radius: 6px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center;">
                    <span style="font-size: 0.68rem; font-weight: 600; opacity: 0.85;">${weekday}</span>
                    <span style="font-size: 1.1rem; margin: 2px 0;" title="${dayInfo.label}">${dayInfo.icon}</span>
                    <span style="font-size: 0.68rem; font-weight: 700; color: #f43f5e;">${maxT} <span style="font-weight: 500; opacity: 0.6; color: #38bdf8;">${minT}</span></span>
                  </div>
                `;
              })}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }
}

/**
 * Custom web component for rendering the POI attraction details card.
 */
@customElement('poi-details-card')
export class PoiDetailsCard extends LitElement {
  @property({ type: Object }) poi: any = null;
  @property({ type: Boolean }) isSaving = false;

  createRenderRoot() {
    return this; // Light DOM for styling integration
  }

  render() {
    if (!this.poi) return html``;
    const { name, lat, lng, formattedAddress, baseColor } = this.poi;
    const colorHex = baseColor ? `rgb(${baseColor.r}, ${baseColor.g}, ${baseColor.b})` : 'var(--color-accent)';

    return html`
      <div class="poi-details-overlay-card animate-fade-in" style="border-left: 4px solid ${colorHex};">
        <button class="poi-close-btn" title="Close details" @click=${() => this.dispatchEvent(new CustomEvent('close'))}>
          <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
            <path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/>
          </svg>
        </button>
        <div class="poi-header">
          <span class="poi-tag" style="background-color: ${colorHex}22; color: ${colorHex};">📍 Attraction Details</span>
          <h3 class="poi-title">${name}</h3>
        </div>
        <p class="poi-address">🗺️ ${formattedAddress}</p>
        <div class="poi-coordinates">
          <span class="coordinate-badge">lat: ${lat.toFixed(5)}°</span>
          <span class="coordinate-badge">lng: ${lng.toFixed(5)}°</span>
        </div>
        <div class="poi-actions">
          <button class="poi-action-btn primary" @click=${() => this.dispatchEvent(new CustomEvent('fly-to'))}>
            <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor">
              <path d="M120-160v-640l760 320-760 320Zm80-120 474-200-474-200v134l240 66-240 66v134Z"/>
            </svg>
            Fly To Position
          </button>
          <button class="poi-action-btn secondary" ?disabled=${this.isSaving} @click=${() => this.dispatchEvent(new CustomEvent('save-bookmark'))}>
            <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor">
              <path d="M200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-780v640L480-240 200-120Zm80-122 200-86 200 86v-544H280v544Zm0-544h400-400Z"/>
            </svg>
            ${this.isSaving ? 'Saving...' : 'Add Bookmark'}
          </button>
        </div>
      </div>
    `;
  }
}

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
  @state() billingError = '';
  @state() mapMode: 'hybrid' | 'satellite' = 'hybrid';
  @state() defaultUiDisabled = true;
  @state() mapHeading = 315;
  @state() mapTilt = 60;
  @state() mapRange = 2500;
  @state() flyDuration = 3000;
  @state() tourDwellTime = 3500;
  @state() optimizeTourPath = false;
  @state() flyEasing: 'sine' | 'cubic' | 'quintic' | 'linear' = 'sine';
  @state() manualSearchQuery = '';
  @state() manualOrigin = '';
  @state() manualDestination = '';
  @state() directionsTravelMode: 'DRIVING' | 'WALKING' | 'TRANSIT' = 'DRIVING';
  @state() cameraFlightActive = false;
  @state() cameraFlightProgress = 0;
  @state() cameraFlightDestinationName = '';
  private cameraFlightAnimId?: number;
  @state() isOrbiting = false;
  @state() showWeatherOverlay = false;
  @state() weatherData: any = null;
  @state() weatherLoading = false;
  @state() weatherError = '';
  @state() weatherUnit: 'C' | 'F' = 'C';
  @state() showWeatherForecast = false;
  @state() bookmarks: Array<{id: string, name: string, lat: number, lng: number, tilt: number, heading: number, range: number, photoUrl?: string}> = [];
  @state() loadingPhotoBookmarkIds: Set<string> = new Set();
  @state() newBookmarkName = '';
  @state() bookmarkIsSaving = false;
  @state() appTheme: 'light' | 'dark' = 'dark';
  @state() showPoiMarkers = false;
  @state() poiLoading = false;
  @state() poiSearchRadius = 1500;
  @state() poiCategoryFilter = 'all';
  @state() poiCustomSearchQuery = '';
  @state() copiedBookmarkId = '';
  @state() editingBookmarkId = '';
  @state() editingBookmarkName = '';
  @state() autoOrbitOnLoad = false;
  @state() autoSaveBookmarkEnabled = false;
  @state() autoSaveBookmarkDelay = 5;
  @state() activeBookmarkId = '';
  @state() lastAddedBookmarkId = '';
  @state() draggedBookmarkId: string | null = null;
  @state() draggedIndex: number | null = null;
  @state() dragOverIndex: number | null = null;
  @state() selectedCategoryFilter = 'All';
  @state() selectedPoi: any = null;
  @state() poiSavingBookmarkId = '';
  @state() timelineVisible = true;
  @state() isTourActive = false;
  @state() tourCurrentIndex = -1;
  @state() tourIsLooping = true;
  @state() centerLat = 37.8199;
  @state() centerLng = -122.4783;
  @state() recentSearches: string[] = [];
  @state() mcpLogs: Array<{ id: string, timestamp: number, name: string, args: any, success: boolean }> = [];

  addMcpLog(name: string, args: any, success = true) {
    const log = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      timestamp: Date.now(),
      name,
      args,
      success
    };
    this.mcpLogs = [log, ...this.mcpLogs].slice(0, 50);
    this.requestUpdate();
  }

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
    try {
      const storedUnit = localStorage.getItem('gdm_map_weather_unit');
      this.weatherUnit = (storedUnit === 'C' || storedUnit === 'F') ? storedUnit : 'C';
    } catch (e) {
      this.weatherUnit = 'C';
    }
    try {
      const storedEasing = localStorage.getItem('gdm_map_fly_easing');
      if (storedEasing === 'sine' || storedEasing === 'cubic' || storedEasing === 'quintic' || storedEasing === 'linear') {
        this.flyEasing = storedEasing;
      } else {
        this.flyEasing = 'sine';
      }
    } catch (e) {
      this.flyEasing = 'sine';
    }
    try {
      const storedDwell = localStorage.getItem('gdm_map_tour_dwell');
      if (storedDwell) {
        this.tourDwellTime = Number(storedDwell);
      } else {
        this.tourDwellTime = 3500;
      }
    } catch (e) {
      this.tourDwellTime = 3500;
    }
    try {
      const storedOptimize = localStorage.getItem('gdm_map_optimize_tour');
      this.optimizeTourPath = storedOptimize === 'true';
    } catch (e) {
      this.optimizeTourPath = false;
    }

    // Intercept Google Maps billing or initialization errors
    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      originalConsoleError.apply(console, args);
      const msg = args.map(arg => typeof arg === 'string' ? arg : (arg?.message || String(arg))).join(' ');
      if (/billing/i.test(msg) || /Geocoding Service/i.test(msg) || /REQUEST_DENIED/i.test(msg)) {
        this.billingError = 'Geocoding or Maps service error: You must enable Billing on the Google Cloud Project. Nominatim backup is active.';
        this.requestUpdate();
      }
    };

    window.addEventListener('error', (event) => {
      const msg = event.message || '';
      if (/billing/i.test(msg) || /Geocoding Service/i.test(msg) || /REQUEST_DENIED/i.test(msg)) {
        this.billingError = 'Geocoding or Maps service error: You must enable Billing on the Google Cloud Project. Nominatim backup is active.';
        this.requestUpdate();
      }
    });

    window.addEventListener('unhandledrejection', (event) => {
      const msg = event.reason?.message || String(event.reason || '');
      if (/billing/i.test(msg) || /Geocoding Service/i.test(msg) || /REQUEST_DENIED/i.test(msg)) {
        this.billingError = 'Geocoding or Maps service error: You must enable Billing on the Google Cloud Project. Nominatim backup is active.';
        this.requestUpdate();
      }
    });

    (window as any).gm_authFailure = () => {
      this.billingError = 'Google Maps API authentication or billing error detected. Please check your API key and enable Billing on the Google Cloud Project. Nominatim backup is active.';
      this.requestUpdate();
    };
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

  private async renderFriendlyMapError(
    errorType: 'geocode' | 'directions',
    rawErrorMsg: string,
    queries: { location?: string; origin?: string; destination?: string }
  ) {
    let title = 'Map Operation Failed';
    let summary = '';
    let suggestions: string[] = [];
    const actions: Array<{ label: string; action: () => void }> = [];

    const isBillingError = /billing/i.test(rawErrorMsg) || /REQUEST_DENIED/i.test(rawErrorMsg) || /Geocoding Service/i.test(rawErrorMsg);

    if (errorType === 'geocode') {
      const q = queries.location || '';
      if (isBillingError) {
        title = 'Google Maps Billing Required';
        summary = `The Google Maps Geocoding service is unavailable because billing is not enabled on your Google Cloud project. However, **we have successfully fallen back to OpenStreetMap (Nominatim)** to run your request!`;
        suggestions = [
          'Enable billing on your Google Cloud Console project by visiting: <a href="https://console.cloud.google.com/project/_/billing/enable" target="_blank" style="color: #38bdf8; text-decoration: underline;">Google Cloud Billing Enablement</a>',
          'Ensure that the Geocoding API is active in your project settings: <a href="https://developers.google.com/maps/gmp-get-started" target="_blank" style="color: #38bdf8; text-decoration: underline;">Google Maps Get Started Guide</a>',
          'Verify that your <code>GOOGLE_MAPS_PLATFORM_KEY</code> secret in AI Studio contains an active, valid API key with billing enabled.',
          'Standard location queries will continue to run using our backup Nominatim geocoder seamlessly.'
        ];
      } else {
        title = 'Location Search Failed';
        summary = `We couldn't find the location **"${q}"** on the map.`;
        suggestions = [
          'Check for typos or spelling errors in your search query.',
          'Be more specific: Try adding a city, state, postal code, or country (e.g., "Machu Picchu, Cusco, Peru" instead of just "Machu Picchu").',
          'If you are entering coordinates, make sure they are in a clean <code>latitude, longitude</code> format (e.g., <code>37.7749, -122.4194</code>).',
          'Ensure that the Geocoding API is enabled on your API key, and billing is active on your Google Cloud project if utilizing Google geocoding.'
        ];
      }
      
      if (q) {
        // Suggest specific alternative actions based on query
        actions.push({
          label: `Try searching with Nominatim (OSM)`,
          action: () => {
            this._geocodeWithNominatim(q)
              .then(loc => {
                if (!this.map) return;
                const cameraOptions = {
                  center: {lat: loc.lat(), lng: loc.lng(), altitude: 0},
                  heading: 0,
                  tilt: 67.5,
                  range: 2000,
                };
                this.startFlightAnimation(this.flyDuration, q);
                (this.map as any).flyCameraTo({
                  endCamera: cameraOptions,
                  durationMillis: this.flyDuration,
                  easingFunction: this.getEasingFunction(this.flyEasing),
                });
                if (this.Marker3DElement) {
                  this.marker = new this.Marker3DElement();
                  this.marker.position = {lat: loc.lat(), lng: loc.lng(), altitude: 0};
                  this.marker.label = q;
                  (this.map as any).appendChild(this.marker);
                }
              })
              .catch(err => {
                console.error('Nominatim fallback retry failed:', err);
              });
          }
        });
      }
    } else if (errorType === 'directions') {
      const orig = queries.origin || '';
      const dest = queries.destination || '';
      
      if (isBillingError) {
        title = 'Google Routes API Billing Required';
        summary = `The Google Maps Routes service is unavailable because billing is not enabled on your Google Cloud project. However, **we have successfully fallen back to a Scenic 3D Flight Arc** to map your path!`;
        suggestions = [
          'Enable billing on your Google Cloud Console project by visiting: <a href="https://console.cloud.google.com/project/_/billing/enable" target="_blank" style="color: #38bdf8; text-decoration: underline;">Google Cloud Billing Enablement</a>',
          'Ensure that the Routes API is enabled on your API key: <a href="https://developers.google.com/maps/gmp-get-started" target="_blank" style="color: #38bdf8; text-decoration: underline;">Google Maps Get Started Guide</a>',
          'Verify that your <code>GOOGLE_MAPS_PLATFORM_KEY</code> secret in AI Studio contains an active, valid API key with billing enabled.',
          'Direct routes will continue to fall back to a scenic 3D flight path connecting geocoded origin and destination points.'
        ];
      } else {
        title = 'Directions Route Failed';
        summary = `We couldn't compute route directions from **"${orig}"** to **"${dest}"**.`;
        suggestions = [
          'Ensure both the origin and destination addresses are spelled correctly.',
          'Try being more specific by adding cities, postal codes, or countries to the addresses.',
          'Verify that a road or transit path exists between these two locations (e.g., routing across oceans without ferry transit is not possible).',
          'Double check your current travel mode (Drive vs. Walk vs. Transit).',
          'Ensure that the Directions API or Routes API is enabled on your Google Cloud Console project.'
        ];
      }

      if (orig && dest) {
        actions.push({
          label: `Render Scenic 3D Flight Arc`,
          action: () => {
            this._clearMapElements();
            Promise.all([
              this._geocodeAddress(orig).catch(() => this._geocodeWithNominatim(orig)),
              this._geocodeAddress(dest).catch(() => this._geocodeWithNominatim(dest))
            ]).then(([originLoc, destLoc]) => {
              if (this.Marker3DElement && this.Polyline3DElement) {
                const pathCoordinates = this._generateArcPath(originLoc, destLoc);
                this.routePolyline = new this.Polyline3DElement();
                this.routePolyline.coordinates = pathCoordinates;
                this.routePolyline.strokeColor = 'cyan';
                this.routePolyline.strokeWidth = 10;
                (this.map as any).appendChild(this.routePolyline);

                this.originMarker = new this.Marker3DElement();
                this.originMarker.position = {lat: originLoc.lat(), lng: originLoc.lng(), altitude: 0};
                this.originMarker.label = orig;
                (this.map as any).appendChild(this.originMarker);

                this.destinationMarker = new this.Marker3DElement();
                this.destinationMarker.position = {lat: destLoc.lat(), lng: destLoc.lng(), altitude: 0};
                this.destinationMarker.label = dest;
                (this.map as any).appendChild(this.destinationMarker);

                const midLat = (originLoc.lat() + destLoc.lat()) / 2;
                const midLng = (originLoc.lng() + destLoc.lng()) / 2;
                const dLat = destLoc.lat() - originLoc.lat();
                const dLng = destLoc.lng() - originLoc.lng();
                const approxDist = Math.sqrt(dLat * dLat + dLng * dLng) * 111000;
                const range = Math.max(approxDist * 1.5, 2500);

                const cameraOptions = {
                  center: {lat: midLat, lng: midLng, altitude: 0},
                  heading: 315,
                  tilt: 55,
                  range: range,
                };
                this.startFlightAnimation(this.flyDuration, `Scenic Path to ${dest}`);
                (this.map as any).flyCameraTo({
                  endCamera: cameraOptions,
                  durationMillis: this.flyDuration,
                  easingFunction: this.getEasingFunction(this.flyEasing),
                });
              }
            }).catch(err => {
              console.error('Scenic 3D fallback flight failed', err);
            });
          }
        });
      }
    }

    const { textElement } = this.addMessage('error', 'Processing error...');
    
    // Construct polished HTML template with error diagnostics
    const cardHtml = `
      <div class="friendly-error-card" style="
        border-left: 4px solid #ef4444;
        background: rgba(30, 27, 46, 0.95);
        border-radius: 4px 12px 12px 4px;
        padding: 16px;
        margin: 8px 0;
        color: #f1f5f9;
        font-family: system-ui, sans-serif;
        box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
      ">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
          <span style="color: #ef4444; font-size: 1.4rem; display: flex; align-items: center;">⚠️</span>
          <h4 style="margin: 0; font-size: 1.1rem; font-weight: 700; color: #f8fafc; letter-spacing: -0.01em;">${title}</h4>
        </div>
        
        <p style="margin: 0 0 12px 0; font-size: 0.9rem; line-height: 1.4; color: #cbd5e1;">
          ${summary}
        </p>

        <div style="margin-bottom: 16px;">
          <span style="font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; display: block; margin-bottom: 6px;">
            Suggested Fixes:
          </span>
          <ul style="margin: 0; padding-left: 18px; font-size: 0.85rem; color: #cbd5e1; display: flex; flex-direction: column; gap: 4px; line-height: 1.4;">
            ${suggestions.map(s => `<li>${s}</li>`).join('')}
          </ul>
        </div>

        ${actions.length > 0 ? `
          <div style="margin-top: 14px; display: flex; flex-wrap: wrap; gap: 8px;">
            <span style="font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; width: 100%; display: block; margin-bottom: 4px;">
              Quick Actions:
            </span>
            ${actions.map((act, idx) => `
              <button class="friendly-error-btn" data-index="${idx}" style="
                background: #0284c7;
                color: #ffffff;
                border: none;
                border-radius: 6px;
                padding: 6px 12px;
                font-size: 0.8rem;
                font-weight: 600;
                cursor: pointer;
                transition: background 0.2s;
                display: flex;
                align-items: center;
                gap: 4px;
              ">
                ${act.label}
              </button>
            `).join('')}
          </div>
        ` : ''}

        <details style="margin-top: 14px; border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 8px;">
          <summary style="font-size: 0.75rem; color: #94a3b8; cursor: pointer; user-select: none;">
            Technical Error Diagnostics
          </summary>
          <pre style="margin: 6px 0 0 0; font-family: monospace; font-size: 0.75rem; color: #ef4444; background: rgba(0, 0, 0, 0.3); padding: 8px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-all;">${rawErrorMsg}</pre>
        </details>
      </div>
    `;

    textElement.innerHTML = cardHtml;

    setTimeout(() => {
      const btns = textElement.querySelectorAll('.friendly-error-btn');
      btns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          const index = parseInt((e.currentTarget as HTMLButtonElement).getAttribute('data-index') || '0', 10);
          const act = actions[index];
          if (act) {
            act.action();
          }
        });
      });
    }, 100);
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
      !this.Marker3DElement
    ) {
      if (!this.mapError) {
        const {textElement} = this.addMessage('error', 'Processing error...');
        textElement.innerHTML = await marked.parse(
          'Map is not ready to display locations. Please check configuration.',
        );
      }
      console.warn(
        'Map not initialized, or Marker3DElement not available, cannot render query.',
      );
      return;
    }
    this._clearMapElements(); // Google Maps: Clear previous elements.

    const handleLocationResult = async (location: any) => {
      if (!this.map) return;

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

      this.startFlightAnimation(this.flyDuration, locationQuery);
      (this.map as any).flyCameraTo({
        endCamera: cameraOptions,
        durationMillis: this.flyDuration,
        easingFunction: this.getEasingFunction(this.flyEasing),
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
    };

    if (!this.geocoder) {
      console.warn('Google Geocoder is not initialized. Using Nominatim fallback.');
      try {
        const fallbackLocation = await this._geocodeWithNominatim(locationQuery);
        await handleLocationResult(fallbackLocation);
      } catch (err: any) {
        await this.renderFriendlyMapError('geocode', `Google Geocoder is not available. Nominatim fallback failed: ${err.message}`, { location: locationQuery });
      }
      return;
    }

    // Google Maps: Use Geocoding service to find the location.
    this.geocoder.geocode(
      {address: locationQuery},
      async (results: any, status: string) => {
        if (status === 'OK' && results && results[0] && this.map) {
          const location = results[0].geometry.location;
          await handleLocationResult(location);
        } else {
          console.warn(`Google geocoding failed with status: ${status}. Falling back to Nominatim.`);
          try {
            const fallbackLocation = await this._geocodeWithNominatim(locationQuery);
            await handleLocationResult(fallbackLocation);
          } catch (err: any) {
            console.error(
              `Geocode was not successful for "${locationQuery}". Reason: ${status}`,
            );
            await this.renderFriendlyMapError('geocode', `Google geocoding failed with status: ${status}. Nominatim fallback failed: ${err.message}`, { location: locationQuery });
          }
        }
      },
    );
  }

  /**
   * Defensive URL construction helper. Validates the base URL and query parameters.
   * If construction fails, logs a diagnostic error and pushes a friendly notification.
   */
  private safeConstructURL(baseUrl: string, params: Record<string, string | number | undefined | null>): URL | null {
    try {
      if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
        throw new Error('Base URL is undefined or empty');
      }

      let resolvedBase = baseUrl.trim();
      if (!resolvedBase.startsWith('http://') && !resolvedBase.startsWith('https://')) {
        try {
          resolvedBase = new URL(resolvedBase, window.location.origin).toString();
        } catch {
          throw new Error(`Base URL "${baseUrl}" is not a valid absolute URL and could not be resolved against window.location.origin.`);
        }
      }

      const url = new URL(resolvedBase);

      for (const [key, val] of Object.entries(params)) {
        if (val === undefined || val === null) {
          console.warn(`[safeConstructURL] Parameter key "${key}" has undefined or null value. Skipping.`);
          continue;
        }
        
        const stringVal = String(val).trim();
        if (key === 'latitude' || key === 'longitude' || key === 'lat' || key === 'lng' || key === 'lon') {
          const num = Number(stringVal);
          if (isNaN(num) || !isFinite(num)) {
            throw new Error(`Coordinate parameter "${key}" contains an invalid numeric value: "${stringVal}"`);
          }
        }

        url.searchParams.set(key, stringVal);
      }

      console.log(`[safeConstructURL] Successfully constructed validated URL: ${url.toString()}`);
      return url;
    } catch (err: any) {
      const errMsg = `Failed to construct URL from base "${baseUrl}" with params: ${JSON.stringify(params)}. Error: ${err.message}`;
      console.error(errMsg);
      
      this.addMessage('error', `
        <div class="url-diagnostic-warning" style="
          border-left: 4px solid #f59e0b;
          background: rgba(45, 34, 18, 0.95);
          border-radius: 4px 12px 12px 4px;
          padding: 12px;
          margin: 6px 0;
          color: #fef3c7;
          font-family: system-ui, sans-serif;
          font-size: 0.85rem;
          line-height: 1.4;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
        ">
          <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-weight: 700; color: #f59e0b;">
            <span>⚠️</span> URL Construction Diagnostic Alert
          </div>
          <p style="margin: 0 0 6px 0;">An error occurred while generating a web link or coordinate API query:</p>
          <code style="display: block; background: rgba(0,0,0,0.4); padding: 6px; border-radius: 4px; font-family: monospace; font-size: 0.75rem; white-space: pre-wrap; word-break: break-all; color: #fca5a5;">${err.message}</code>
          <p style="margin: 6px 0 0 0; font-size: 0.75rem; color: #d97706;">Recommended fix: Check input parameters, make sure coordinates are valid numbers and window location is properly initialized.</p>
        </div>
      `);
      return null;
    }
  }

  private async _geocodeWithNominatim(address: string): Promise<any> {
    try {
      if (!address || typeof address !== 'string' || !address.trim()) {
        throw new Error('Invalid address query for Nominatim geocoding');
      }

      const url = this.safeConstructURL('https://nominatim.openstreetmap.org/search', {
        q: address.trim(),
        format: 'json',
        limit: '1'
      });
      if (!url) {
        throw new Error('URL construction failed for Nominatim geocoding');
      }

      const response = await fetch(
        url.toString(),
        {
          headers: {
            'User-Agent': 'AI-Studio-Map-App/1.0',
          },
        }
      );
      if (!response.ok) {
        throw new Error(`Nominatim HTTP error: ${response.status}`);
      }
      const data = await response.json();
      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat);
        const lng = parseFloat(data[0].lon);
        if (isNaN(lat) || isNaN(lng)) {
          throw new Error('Nominatim returned invalid coordinate formats');
        }
        return {
          lat: () => lat,
          lng: () => lng,
          toString: () => `${lat},${lng}`,
        };
      }
      throw new Error('No results found via Nominatim');
    } catch (err) {
      console.error('Nominatim geocode failed:', err);
      throw err;
    }
  }

  private async _reverseGeocodeWithNominatim(lat: number, lng: number): Promise<string> {
    try {
      const latNum = Number(lat);
      const lngNum = Number(lng);
      if (isNaN(latNum) || !isFinite(latNum) || isNaN(lngNum) || !isFinite(lngNum)) {
        throw new Error('Invalid coordinates supplied for Nominatim reverse geocoding');
      }

      const url = this.safeConstructURL('https://nominatim.openstreetmap.org/reverse', {
        lat: latNum.toString(),
        lon: lngNum.toString(),
        format: 'json'
      });
      if (!url) {
        throw new Error('URL construction failed for Nominatim reverse geocoding');
      }

      const response = await fetch(
        url.toString(),
        {
          headers: {
            'User-Agent': 'AI-Studio-Map-App/1.0',
          },
        }
      );
      if (!response.ok) {
        throw new Error(`Nominatim HTTP error: ${response.status}`);
      }
      const data = await response.json();
      if (data && data.display_name) {
        return data.display_name;
      }
      throw new Error('No address found');
    } catch (err) {
      console.error('Nominatim reverse geocode failed:', err);
      throw err;
    }
  }

  /**
   * Geocodes a single address query and returns its LatLng coordinate object.
   */
  private _geocodeAddress(address: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.geocoder) {
        this._geocodeWithNominatim(address)
          .then(resolve)
          .catch(() => reject(new Error('Geocoder not initialized and Nominatim failed')));
        return;
      }
      this.geocoder.geocode({address}, (results: any, status: string) => {
        if (status === 'OK' && results && results[0]) {
          resolve(results[0].geometry.location);
        } else {
          console.warn(`Google geocoding failed with status: ${status}. Falling back to Nominatim.`);
          this._geocodeWithNominatim(address)
            .then(resolve)
            .catch((err) => reject(new Error(`Geocode failed with status: ${status} and fallback failed: ${err.message}`)));
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
    mode?: 'DRIVING' | 'WALKING' | 'TRANSIT',
  ) {
    if (
      !this.mapInitialized ||
      !this.map ||
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

    const travelMode = mode || this.directionsTravelMode || 'DRIVING';

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
        travelMode: travelMode as any,
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
          let strokeColor = 'blue';
          if (travelMode === 'WALKING') {
            strokeColor = '#10b981';
          } else if (travelMode === 'TRANSIT') {
            strokeColor = '#a855f7';
          }
          this.routePolyline.strokeColor = strokeColor;
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

          this.startFlightAnimation(this.flyDuration, `Route to ${destinationQuery}`);
          (this.map as any).flyCameraTo({
            endCamera: cameraOptions,
            durationMillis: this.flyDuration,
            easingFunction: this.getEasingFunction(this.flyEasing),
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

              this.startFlightAnimation(this.flyDuration, `Scenic Path to ${destinationQuery}`);
              (this.map as any).flyCameraTo({
                endCamera: cameraOptions,
                durationMillis: this.flyDuration,
                easingFunction: this.getEasingFunction(this.flyEasing),
              });

              infoMsg.innerHTML = await marked.parse(
                `✈️ **Scenic 3D Flight Path Rendered!**\n\n*   **From:** ${originQuery}\n*   **To:** ${destinationQuery}\n*   **Flight Distance:** ${this.formatRange(Math.round(range / 1.5))}\n\n*You can use the settings panel on the right to rotate, tilt, or toggle the automatic target orbit!*`
              );
            }
          } catch (err: any) {
            console.error('Fallback geocoding or path rendering failed:', err);
            await this.renderFriendlyMapError('directions', `Routes API failed with: ${routeError.message || routeError}. Fallback scenic geocoding flight path also failed: ${err.message}`, { origin: originQuery, destination: destinationQuery });
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
    if (params._toolCallName) {
      this.addMcpLog(params._toolCallName, params._toolCallArgs || {});
    }

    if (params.location) {
      this._handleViewLocation(params.location);
    } else if (params.origin && params.destination) {
      this._handleDirections(params.origin, params.destination);
    } else if (params.destination) {
      // Fallback if only destination is provided, treat as viewing a location
      this._handleViewLocation(params.destination);
    }

    if (params.weather !== undefined) {
      this.showWeatherOverlay = params.weather;
      if (this.showWeatherOverlay) {
        this.fetchWeatherForCenter();
      } else {
        this.weatherData = null;
        this.weatherError = '';
      }
    }

    if (params.poi !== undefined) {
      this.showPoiMarkers = params.poi.enable;
      if (params.poi.radius !== undefined) {
        this.poiSearchRadius = params.poi.radius;
      }
      if (params.poi.category !== undefined) {
        this.poiCategoryFilter = params.poi.category;
      }
      if (this.showPoiMarkers) {
        this.fetchPoiForCenter();
      } else {
        this.clearPoiMarkers();
      }
    }

    if (params.camera !== undefined) {
      const tilt = params.camera.tilt !== undefined ? params.camera.tilt : this.mapTilt;
      const heading = params.camera.heading !== undefined ? params.camera.heading : this.mapHeading;
      const range = params.camera.range !== undefined ? params.camera.range : this.mapRange;
      this.flyTo(this.centerLat, this.centerLng, tilt, heading, range);
    }

    if (params.bookmark !== undefined) {
      if (params.bookmark.action === 'add') {
        const name = params.bookmark.name || `View at ${this.centerLat.toFixed(4)}, ${this.centerLng.toFixed(4)}`;
        const bId = 'b_' + Date.now();
        const newB = {
          id: bId,
          name: name,
          lat: this.centerLat,
          lng: this.centerLng,
          tilt: this.mapTilt,
          heading: this.mapHeading,
          range: this.mapRange,
        };
        this.bookmarks = [newB, ...this.bookmarks];
        this.activeBookmarkId = bId;
        this.lastAddedBookmarkId = bId;
        this.saveBookmarksToStorage();
        this.addMessage('assistant', `I have saved this view as a bookmark named "${name}".`);
        this.fetchPhotoForBookmark(bId);
      } else if (params.bookmark.action === 'list') {
        const bookmarkNames = this.bookmarks.map(b => b.name).join(', ');
        this.addMessage('assistant', `Your saved bookmarks are: ${bookmarkNames || 'None yet.'}`);
      }
    }

    if (params.tour !== undefined) {
      if (params.tour.action === 'play') {
        if (this.bookmarks.length === 0) {
          this.addMessage('assistant', "You don't have any saved bookmarks to tour. Add some first!");
        } else {
          this.startTour();
        }
      } else if (params.tour.action === 'stop') {
        this.stopTour();
      }
    }

    this.requestUpdate();
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

  startFlightAnimation(duration: number, destination: string) {
    if (this.cameraFlightAnimId !== undefined) {
      cancelAnimationFrame(this.cameraFlightAnimId);
      this.cameraFlightAnimId = undefined;
    }

    this.cameraFlightActive = true;
    this.cameraFlightProgress = 0;
    this.cameraFlightDestinationName = destination || 'Selected Location';

    const startTime = performance.now();

    const animate = (time: number) => {
      const elapsed = time - startTime;
      const rawProgress = Math.min(elapsed / duration, 1);
      const easedProgress = this.getEasingFunction(this.flyEasing)(rawProgress);
      this.cameraFlightProgress = easedProgress * 100;

      if (rawProgress < 1) {
        this.cameraFlightAnimId = requestAnimationFrame(animate);
      } else {
        setTimeout(() => {
          this.cameraFlightActive = false;
          this.requestUpdate();
        }, 400);
      }
      this.requestUpdate();
    };

    this.cameraFlightAnimId = requestAnimationFrame(animate);
  }

  flyTo(lat: number, lng: number, tilt: number, heading: number, range: number, bookmarkId?: string, fromTour = false) {
    if (!this.mapInitialized || !this.map) return;

    if (!fromTour && this.isTourActive) {
      this.stopTour();
    }

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
    
    let destName = '';
    if (bookmarkId) {
      const b = this.bookmarks.find(x => x.id === bookmarkId);
      if (b) destName = b.name;
    }
    if (!destName) {
      destName = `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`;
    }
    this.startFlightAnimation(this.flyDuration, destName);

    (this.map as any).flyCameraTo({
      endCamera: cameraOptions,
      durationMillis: this.flyDuration,
      easingFunction: this.getEasingFunction(this.flyEasing),
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
              console.warn('Google reverse geocoding failed. Falling back to Nominatim.');
              this._reverseGeocodeWithNominatim(lat, lng)
                .then((addr) => resolve(addr.split(',')[0] || `Auto-saved View`))
                .catch(() => resolve(`Auto-saved View (${lat.toFixed(3)}, ${lng.toFixed(3)})`));
            }
          });
        });
      } catch {
        try {
          const addr = await this._reverseGeocodeWithNominatim(lat, lng);
          name = addr.split(',')[0] || `Auto-saved View`;
        } catch {
          name = `Auto-saved View (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
        }
      }
    } else {
      try {
        const addr = await this._reverseGeocodeWithNominatim(lat, lng);
        name = addr.split(',')[0] || `Auto-saved View`;
      } catch {
        name = `Auto-saved View (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
      }
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
    this.lastAddedBookmarkId = newBookmark.id;
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

  private tourTimeoutId?: any;

  getDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  getPathDistance(list: any[]): number {
    let total = 0;
    for (let i = 0; i < list.length - 1; i++) {
      total += this.getDistance(list[i].lat, list[i].lng, list[i+1].lat, list[i+1].lng);
    }
    return total;
  }

  getOptimizedPath(list: any[]): any[] {
    if (list.length <= 2) return list;
    
    const unvisited = [...list];
    const optimized: any[] = [];
    
    // Start with the first bookmark to anchor the route
    const first = unvisited.shift()!;
    optimized.push(first);
    
    let current = first;
    while (unvisited.length > 0) {
      let nearestIndex = 0;
      let minDistance = Infinity;
      
      for (let i = 0; i < unvisited.length; i++) {
        const dist = this.getDistance(current.lat, current.lng, unvisited[i].lat, unvisited[i].lng);
        if (dist < minDistance) {
          minDistance = dist;
          nearestIndex = i;
        }
      }
      
      current = unvisited[nearestIndex];
      unvisited.splice(nearestIndex, 1);
      optimized.push(current);
    }
    
    return optimized;
  }

  toggleOptimizeTourPath() {
    this.optimizeTourPath = !this.optimizeTourPath;
    try {
      localStorage.setItem('gdm_map_optimize_tour', String(this.optimizeTourPath));
    } catch (e) {
      console.error(e);
    }
    this.requestUpdate();
  }

  getTourBookmarks() {
    let chronological = [...this.bookmarks].reverse();
    const isFiltered = this.selectedCategoryFilter !== 'All' && this.selectedCategoryFilter !== 'Sort';
    if (isFiltered) {
      chronological = chronological.filter(
        b => this.getBookmarkCategory(b.name) === this.selectedCategoryFilter
      );
    }
    if (this.optimizeTourPath && chronological.length > 2) {
      return this.getOptimizedPath(chronological);
    }
    return chronological;
  }

  startTour() {
    const list = this.getTourBookmarks();
    if (list.length === 0) return;

    this.isTourActive = true;
    this.tourCurrentIndex = 0;
    this.runTourStep();
  }

  stopTour() {
    this.isTourActive = false;
    this.tourCurrentIndex = -1;
    if (this.tourTimeoutId) {
      clearTimeout(this.tourTimeoutId);
      this.tourTimeoutId = undefined;
    }
  }

  runTourStep() {
    if (!this.isTourActive) return;
    const list = this.getTourBookmarks();
    if (list.length === 0) {
      this.stopTour();
      return;
    }

    if (this.tourCurrentIndex < 0 || this.tourCurrentIndex >= list.length) {
      if (this.tourIsLooping) {
        this.tourCurrentIndex = 0;
      } else {
        this.stopTour();
        return;
      }
    }

    const b = list[this.tourCurrentIndex];
    this.flyTo(b.lat, b.lng, b.tilt, b.heading, b.range, b.id, true);

    const dwellDuration = this.tourDwellTime;
    const stepDuration = this.flyDuration + dwellDuration;

    this.tourTimeoutId = setTimeout(() => {
      if (!this.isTourActive) return;
      this.tourCurrentIndex++;
      this.runTourStep();
    }, stepDuration);
    
    this.requestUpdate();
  }

  nextTourStep() {
    if (!this.isTourActive) return;
    if (this.tourTimeoutId) clearTimeout(this.tourTimeoutId);
    
    const list = this.getTourBookmarks();
    if (list.length === 0) {
      this.stopTour();
      return;
    }
    this.tourCurrentIndex = (this.tourCurrentIndex + 1) % list.length;
    this.runTourStep();
  }

  prevTourStep() {
    if (!this.isTourActive) return;
    if (this.tourTimeoutId) clearTimeout(this.tourTimeoutId);
    
    const list = this.getTourBookmarks();
    if (list.length === 0) {
      this.stopTour();
      return;
    }
    this.tourCurrentIndex = (this.tourCurrentIndex - 1 + list.length) % list.length;
    this.runTourStep();
  }

  toggleTourLoop() {
    this.tourIsLooping = !this.tourIsLooping;
  }

  getBookmarkEmoji(name: string): string {
    // Check if name has an emoji at the start
    const emojiRegex = /(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/;
    const match = name.match(emojiRegex);
    if (match && match.length > 0) {
      return match[0];
    }
    
    // Otherwise determine based on category
    const cat = this.getBookmarkCategory(name);
    return this.getCategoryEmoji(cat);
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

    // Show chronologically: oldest first, latest last, or optimized if enabled
    const chronologicalBookmarks = this.getTourBookmarks();
    const isFiltered = this.selectedCategoryFilter !== 'All' && this.selectedCategoryFilter !== 'Sort';

    // Calculate path length comparison to show optimization savings for scattered bookmarks
    let savingsMessage = '';
    let pctSaved = 0;
    if (this.bookmarks.length > 2) {
      const defaultList = [...this.bookmarks].reverse();
      let rawList = defaultList;
      if (isFiltered) {
        rawList = defaultList.filter(b => this.getBookmarkCategory(b.name) === this.selectedCategoryFilter);
      }
      
      if (rawList.length > 2) {
        const rawDist = this.getPathDistance(rawList);
        const optList = this.getOptimizedPath(rawList);
        const optDist = this.getPathDistance(optList);
        
        if (rawDist > optDist + 0.1) {
          pctSaved = Math.round(((rawDist - optDist) / rawDist) * 100);
          savingsMessage = `Smart routing optimizes this sequence to save ${pctSaved}% total travel distance! (${Math.round(rawDist - optDist)} km saved)`;
        }
      }
    }

    return html`
      <div class="map-timeline-island ${this.timelineVisible ? 'expanded' : 'collapsed'}">
        <div class="timeline-header">
          <div class="timeline-header-left" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span class="timeline-dot"></span>
            <span class="timeline-title">📍 Journey Route & Timeline</span>
            <span class="timeline-count-badge">
              ${isFiltered 
                ? `${chronologicalBookmarks.length}/${this.bookmarks.length} nodes` 
                : `${this.bookmarks.length} nodes`}
            </span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <!-- Smart Route Toggle button in header if scattered -->
            ${chronologicalBookmarks.length > 2 && pctSaved > 0 ? html`
              <button 
                class="timeline-filter-btn ${this.optimizeTourPath ? 'active' : ''}"
                @click=${this.toggleOptimizeTourPath}
                title="${savingsMessage || 'Optimize sequence for scattered stops'}"
                style="gap: 6px; position: relative;">
                <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor">
                  <path d="M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q106 0 191.5 54.5T802-640h-86q-33-54-89-87t-147-33q-116 0-198 82t-82 198q0 116 82 198t198 82q116 0 198-82t82-198q0-11-1-21t-4-21l64-64q11 25 17.5 52.5T840-480q0 150-105 255T480-120Z"/>
                  <path d="m396-384 272-272-56-56-216 216-96-96-56 56 152 152Z"/>
                </svg>
                <span>Smart Route</span>
                <span class="route-savings-badge ${this.optimizeTourPath ? 'active' : ''}" style="font-size: 0.65rem; background-color: ${this.optimizeTourPath ? '#10b981' : '#0ea5e9'}; color: white; padding: 1px 5px; border-radius: 9999px; font-weight: bold; margin-left: 2px;">
                  ${this.optimizeTourPath ? `Saved ${pctSaved}%` : `-${pctSaved}%`}
                </span>
              </button>
            ` : ''}

            <!-- Auto-Tour Play / Pause & Controls -->
            <button 
              class="timeline-filter-btn ${this.isTourActive ? 'active' : ''}"
              @click=${this.isTourActive ? this.stopTour : this.startTour}
              title="${this.isTourActive ? 'Stop Auto-Tour' : 'Start Auto-Tour of Timeline'}"
              style="gap: 6px;">
              ${this.isTourActive ? html`
                <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor">
                  <path d="M320-640v320h80V-640h-80Zm240 0v320h80V-640h-80Z"/>
                </svg>
                <span>Stop Tour</span>
              ` : html`
                <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor">
                  <path d="M320-203v-554l440 277-440 277Zm80-277Zm0 144 229-144-229-144v288Z"/>
                </svg>
                <span>Play Tour</span>
              `}
            </button>

            ${this.isTourActive ? html`
              <div style="display: flex; align-items: center; gap: 4px; background-color: light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)); border-radius: 9999px; padding: 2px 6px; border: 1px dashed light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.1));">
                <button 
                  class="timeline-collapse-btn" 
                  style="padding: 2px; border-radius: 999px;" 
                  @click=${this.prevTourStep} 
                  title="Previous Landmark">
                  <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                    <path d="M560-240 320-480l240-240 56 56-184 184 184 184-56 56Z"/>
                  </svg>
                </button>
                <span style="font-size: 0.7rem; font-weight: 600; color: var(--color-accent, #f59e0b); font-family: monospace; min-width: 32px; text-align: center;">
                  ${this.tourCurrentIndex + 1}/${chronologicalBookmarks.length}
                </span>
                <button 
                  class="timeline-collapse-btn" 
                  style="padding: 2px; border-radius: 999px;" 
                  @click=${this.nextTourStep} 
                  title="Next Landmark">
                  <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                    <path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z"/>
                  </svg>
                </button>
                <button 
                  class="timeline-collapse-btn ${this.tourIsLooping ? 'active' : ''}" 
                  style="padding: 2px; border-radius: 999px; color: ${this.tourIsLooping ? 'var(--color-accent, #f59e0b)' : 'inherit'};" 
                  @click=${this.toggleTourLoop} 
                  title="${this.tourIsLooping ? 'Disable Loop' : 'Enable Loop'}">
                  <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor">
                    <path d="M160-200v-120q0-50 35-85t85-35h360l-80 80 56 56 176-176-176-176-56 56 80 80H280q-83 0-141.5 58.5T80 320v120h80Zm640-560v120q0 50-35 85t-85 35H360l80-80-56-56-176 176 176 176 56-56-80-80h280q83 0 141.5-58.5T880-640v-120h-80Z"/>
                  </svg>
                </button>
              </div>
            ` : ''}

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
        </div>

        ${this.timelineVisible ? html`
          ${chronologicalBookmarks.length === 0 ? html`
            <div style="padding: 24px; text-align: center; font-size: 0.75rem; color: var(--color-text3, #888); font-style: italic;">
              No saved bookmarks match category "${this.selectedCategoryFilter}" on the timeline.
            </div>
          ` : html`
            <div class="timeline-track-container" @wheel=${this.handleTimelineWheel}>
              <div class="timeline-connector-bar"></div>
              <div class="timeline-nodes">
                ${chronologicalBookmarks.map((b, index) => {
                  const isActive = this.activeBookmarkId === b.id;
                  const photoUrl = this.getBookmarkPhoto(b.name, b.id);
                  const categoryEmoji = this.getBookmarkEmoji(b.name);
                  
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
          `}
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

  toggleWeatherForecast() {
    this.showWeatherForecast = !this.showWeatherForecast;
    this.requestUpdate();
  }

  setWeatherUnit(unit: 'C' | 'F') {
    this.weatherUnit = unit;
    try {
      localStorage.setItem('gdm_map_weather_unit', unit);
    } catch (e) {
      console.error('Error saving weather unit:', e);
    }
    this.requestUpdate();
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

  onPoiCategorySelect(category: string) {
    this.poiCustomSearchQuery = '';
    this.poiCategoryFilter = category;
    if (this.showPoiMarkers) {
      this.fetchPoiForCenter();
    }
  }

  onPoiCustomSearch(query: string) {
    this.poiCustomSearchQuery = query;
    this.poiCategoryFilter = query ? 'custom' : 'all';
    if (this.showPoiMarkers) {
      this.fetchPoiForCenter();
    }
  }

  clearPoiCustomSearch() {
    this.poiCustomSearchQuery = '';
    this.poiCategoryFilter = 'all';
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
        
        let response;
        let baseColor = { r: 245, g: 158, b: 11 }; // Default Golden

        if (this.poiCustomSearchQuery && this.poiCustomSearchQuery.trim()) {
          baseColor = { r: 244, g: 63, b: 94 }; // Vibrant Coral/Rose for custom search results
          response = await Place.searchByText({
            textQuery: this.poiCustomSearchQuery,
            fields: ['displayName', 'location', 'formattedAddress'],
            locationBias: {
              center: { lat, lng },
              radius: this.poiSearchRadius,
            },
            maxResultCount: 20
          });
        } else {
          let includedTypes = ['tourist_attraction'];

          if (this.poiCategoryFilter === 'museums') {
            includedTypes = ['museum'];
            baseColor = { r: 14, g: 165, b: 233 }; // Sky Blue / Teal
          } else if (this.poiCategoryFilter === 'parks') {
            includedTypes = ['park', 'amusement_park', 'national_park'];
            baseColor = { r: 16, g: 185, b: 129 }; // Emerald Green
          } else if (this.poiCategoryFilter === 'religious') {
            includedTypes = ['place_of_worship', 'church', 'hindu_temple', 'mosque', 'synagogue'];
            baseColor = { r: 168, g: 85, b: 247 }; // Elegant Purple
          }

          response = await Place.searchNearby({
            locationRestriction: {
              center: { lat, lng },
              radius: this.poiSearchRadius,
            },
            includedTypes,
            fields: ['displayName', 'location', 'formattedAddress']
          });
        }

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
                color: { r: baseColor.r, g: baseColor.g, b: baseColor.b, a: 1 }
              };

              // Setup high-performance 3D hover/bounce interaction with dynamic base color
              this.setupMarkerHover(marker, pLat, pLng, baseColor);

              const onMarkerClick = (e: Event) => {
                e.stopPropagation();
                this.selectedPoi = {
                  name: place.displayName || 'Attraction',
                  lat: pLat,
                  lng: pLng,
                  formattedAddress: place.formattedAddress || 'No address details available',
                  baseColor: baseColor
                };
                this.requestUpdate();
              };

              marker.addEventListener('gmp-click', onMarkerClick);
              marker.addEventListener('click', onMarkerClick);

              marker._cleanupClick = () => {
                marker.removeEventListener('gmp-click', onMarkerClick);
                marker.removeEventListener('click', onMarkerClick);
              };

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

  setupMarkerHover(marker: any, pLat: number, pLng: number, baseColor = { r: 245, g: 158, b: 11 }) {
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

      // Visually pulse the color brighter when bouncing
      const r = Math.round(baseColor.r + bounce * (Math.min(255, baseColor.r + 50) - baseColor.r));
      const g = Math.round(baseColor.g + bounce * (Math.min(255, baseColor.g + 50) - baseColor.g));
      const b = Math.round(baseColor.b + bounce * (Math.min(255, baseColor.b + 50) - baseColor.b));
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

        // Transition color back to base color
        const r = Math.round(baseColor.r + (1 - progress) * (((marker.style?.color?.r ?? baseColor.r)) - baseColor.r));
        const g = Math.round(baseColor.g + (1 - progress) * (((marker.style?.color?.g ?? baseColor.g)) - baseColor.g));
        const b = Math.round(baseColor.b + (1 - progress) * (((marker.style?.color?.b ?? baseColor.b)) - baseColor.b));
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
          if (marker._cleanupClick) {
            marker._cleanupClick();
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
    
    const latNum = Number(lat);
    const lngNum = Number(lng);
    
    if (isNaN(latNum) || !isFinite(latNum) || isNaN(lngNum) || !isFinite(lngNum)) {
      this.weatherError = 'Invalid map center coordinates for weather forecast.';
      return;
    }

    this.weatherLoading = true;
    this.weatherError = '';
    this.requestUpdate();
    
    try {
      const url = this.safeConstructURL('https://api.open-meteo.com/v1/forecast', {
        latitude: latNum.toFixed(4),
        longitude: lngNum.toFixed(4),
        current_weather: 'true',
        daily: 'weathercode,temperature_2m_max,temperature_2m_min',
        timezone: 'auto'
      });
      if (!url) {
        throw new Error('URL construction failed for Open-Meteo weather API');
      }

      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Weather API returned status: ${response.status}`);
      }
      const data = await response.json();
      if (data && data.current_weather) {
        // Extract 3-day forecast
        const forecast: any[] = [];
        if (data.daily && data.daily.time) {
          for (let i = 0; i < Math.min(3, data.daily.time.length); i++) {
            forecast.push({
              date: data.daily.time[i],
              weathercode: data.daily.weathercode[i],
              tempMax: data.daily.temperature_2m_max[i],
              tempMin: data.daily.temperature_2m_min[i]
            });
          }
        }

        this.weatherData = {
          temperature: data.current_weather.temperature,
          windspeed: data.current_weather.windspeed,
          winddirection: data.current_weather.winddirection,
          weathercode: data.current_weather.weathercode,
          time: data.current_weather.time,
          lat: lat,
          lng: lng,
          forecast: forecast
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

  renderWeatherEffects(bgClass: string) {
    switch (bgClass) {
      case 'weather-clear':
        return html`<div class="weather-effect-clear-flare"></div>`;
      case 'weather-cloudy':
        return html`
          <div class="weather-effect-cloud cloud-1"></div>
          <div class="weather-effect-cloud cloud-2"></div>
        `;
      case 'weather-rainy':
        return html`
          <div class="weather-effect-rain-drop drop-1"></div>
          <div class="weather-effect-rain-drop drop-2"></div>
          <div class="weather-effect-rain-drop drop-3"></div>
          <div class="weather-effect-rain-drop drop-4"></div>
          <div class="weather-effect-rain-drop drop-5"></div>
        `;
      case 'weather-snowy':
        return html`
          <div class="weather-effect-snow-flake flake-1">❄</div>
          <div class="weather-effect-snow-flake flake-2">❄</div>
          <div class="weather-effect-snow-flake flake-3">❄</div>
          <div class="weather-effect-snow-flake flake-4">❄</div>
          <div class="weather-effect-snow-flake flake-5">❄</div>
        `;
      case 'weather-stormy':
        return html`
          <div class="weather-effect-lightning-flash"></div>
          <div class="weather-effect-rain-drop drop-1"></div>
          <div class="weather-effect-rain-drop drop-2"></div>
          <div class="weather-effect-rain-drop drop-3"></div>
          <div class="weather-effect-rain-drop drop-4"></div>
        `;
      case 'weather-fog':
        return html`
          <div class="weather-effect-fog-mist mist-1"></div>
          <div class="weather-effect-fog-mist mist-2"></div>
        `;
      default:
        return html``;
    }
  }

  renderWeatherCard() {
    if (!this.showWeatherOverlay) {
      return html``;
    }

    return html`
      <weather-overlay-card
        .weatherData=${this.weatherData}
        .weatherLoading=${this.weatherLoading}
        .weatherError=${this.weatherError}
        .weatherUnit=${this.weatherUnit}
        .showWeatherForecast=${this.showWeatherForecast}
        @retry-weather=${this.fetchWeatherForCenter}
        @toggle-forecast=${this.toggleWeatherForecast}
        @toggle-unit=${() => this.setWeatherUnit(this.weatherUnit === 'C' ? 'F' : 'C')}
      ></weather-overlay-card>
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
                console.warn('Google reverse geocoding failed. Falling back to Nominatim.');
                this._reverseGeocodeWithNominatim(lat, lng)
                  .then((addr) => resolve(addr.split(',')[0] || `View Point`))
                  .catch(() => resolve(`View (${lat.toFixed(3)}, ${lng.toFixed(3)})`));
              }
            });
          });
        } catch {
          try {
            const addr = await this._reverseGeocodeWithNominatim(lat, lng);
            name = addr.split(',')[0] || `View Point`;
          } catch {
            name = `View (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
          }
        }
      } else {
        try {
          const addr = await this._reverseGeocodeWithNominatim(lat, lng);
          name = addr.split(',')[0] || `View Point`;
        } catch {
          name = `View (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
        }
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
    this.lastAddedBookmarkId = newBookmark.id;
    this.saveBookmarksToStorage();
    this.newBookmarkName = '';
    this.bookmarkIsSaving = false;
    this.requestUpdate();
    
    // Automatically trigger photo fetch in background
    this.fetchPhotoForBookmark(newBookmark.id);
  }

  async savePoiAsBookmark(poi: any) {
    if (!poi) return;
    this.poiSavingBookmarkId = 'saving';
    try {
      const bId = 'b_' + Date.now();
      const newB = {
        id: bId,
        name: '📍 ' + poi.name,
        lat: poi.lat,
        lng: poi.lng,
        tilt: 45,
        heading: 0,
        range: 1000,
      };
      this.bookmarks = [newB, ...this.bookmarks];
      this.activeBookmarkId = bId;
      this.lastAddedBookmarkId = bId;
      this.saveBookmarksToStorage();
      this.addMessage('assistant', `I have saved "${poi.name}" as a journey bookmark for you! You can find it under your saved views in the settings panel.`);
      this.fetchPhotoForBookmark(bId);
    } catch (e) {
      console.error('Error saving POI as bookmark', e);
    } finally {
      this.poiSavingBookmarkId = '';
    }
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

  async fetchPhotoForBookmark(id: string) {
    const bookmark = this.bookmarks.find(b => b.id === id);
    if (!bookmark) return;

    this.loadingPhotoBookmarkIds.add(id);
    this.loadingPhotoBookmarkIds = new Set(this.loadingPhotoBookmarkIds);
    this.requestUpdate();

    try {
      const google = (window as any).google;
      if (google && google.maps) {
        const { Place } = await google.maps.importLibrary('places');
        
        // 1. Try searchByText with the bookmark name to find the location and its photos
        let response = await Place.searchByText({
          textQuery: bookmark.name,
          fields: ['displayName', 'photos', 'id'],
          locationBias: { lat: bookmark.lat, lng: bookmark.lng },
          maxResultCount: 1
        });

        let photoUrl = '';

        if (response && response.places && response.places.length > 0) {
          const place = response.places[0];
          if (place.photos && place.photos.length > 0) {
            photoUrl = place.photos[0].getURI({ maxWidth: 200, maxHeight: 200 });
          }
        }

        // 2. If no photo found, try searchNearby around the exact coordinates to get any representative photo
        if (!photoUrl) {
          response = await Place.searchNearby({
            locationRestriction: {
              center: { lat: bookmark.lat, lng: bookmark.lng },
              radius: 500,
            },
            fields: ['displayName', 'photos'],
            maxResultCount: 5
          });

          if (response && response.places && response.places.length > 0) {
            for (const place of response.places) {
              if (place.photos && place.photos.length > 0) {
                photoUrl = place.photos[0].getURI({ maxWidth: 200, maxHeight: 200 });
                break;
              }
            }
          }
        }

        if (photoUrl) {
          // Save the photo to the bookmark and persist it
          this.bookmarks = this.bookmarks.map(b => {
            if (b.id === id) {
              return { ...b, photoUrl };
            }
            return b;
          });
          this.saveBookmarksToStorage();
        } else {
          console.warn('No Place Photo found for bookmark:', bookmark.name);
        }
      }
    } catch (err) {
      console.error('Error fetching photo for bookmark:', err);
    } finally {
      this.loadingPhotoBookmarkIds.delete(id);
      this.loadingPhotoBookmarkIds = new Set(this.loadingPhotoBookmarkIds);
      this.requestUpdate();
    }
  }

  getBookmarkPhoto(name: string, id: string): string {
    const bookmark = this.bookmarks.find(b => b.id === id);
    if (bookmark && bookmark.photoUrl) {
      return bookmark.photoUrl;
    }
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
      case 'Nature': return '🏞️';
      case 'Coastlines': return '🏖️';
      default: return '📍';
    }
  }

  shareBookmark(b: {id: string, name: string, lat: number, lng: number, tilt: number, heading: number, range: number}) {
    // 1. Coordinate and input parameter validation
    const latNum = Number(b.lat);
    const lngNum = Number(b.lng);
    const tiltNum = Number(b.tilt);
    const headingNum = Number(b.heading);
    const rangeNum = Number(b.range);

    if (
      isNaN(latNum) || !isFinite(latNum) ||
      isNaN(lngNum) || !isFinite(lngNum)
    ) {
      console.error('Invalid coordinates in bookmark share request:', b);
      return;
    }

    try {
      // 2. Safe URL construction with validation of location href
      const baseHref = window.location.href;
      if (!baseHref || typeof baseHref !== 'string' || !baseHref.startsWith('http')) {
        throw new Error('window.location.href is invalid or not absolute');
      }

      const url = this.safeConstructURL(baseHref, {
        lat: latNum.toFixed(6),
        lng: lngNum.toFixed(6),
        tilt: isNaN(tiltNum) ? '0' : Math.round(tiltNum).toString(),
        heading: isNaN(headingNum) ? '0' : Math.round(headingNum).toString(),
        range: isNaN(rangeNum) ? '2000' : Math.round(rangeNum).toString()
      });

      if (!url) {
        throw new Error('URL construction failed for bookmark share link');
      }

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
    } catch (urlErr) {
      console.error('Failed to construct share URL safely:', urlErr);
    }
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

  _onBookmarkDragStart(e: DragEvent, id: string, index: number) {
    this.draggedBookmarkId = id;
    this.draggedIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    }
    const target = e.currentTarget as HTMLElement;
    target.classList.add('dragging');
  }

  _onBookmarkDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    if (this.draggedIndex === null || this.draggedIndex === index) return;
    this.dragOverIndex = index;
  }

  _onBookmarkDrop(e: DragEvent, targetIndex: number) {
    e.preventDefault();
    if (this.draggedIndex === null || this.draggedIndex === targetIndex) {
      this._onBookmarkDragEnd();
      return;
    }

    let displayBookmarks = [...this.bookmarks];
    if (this.selectedCategoryFilter === 'Sort') {
      displayBookmarks.sort((a, b) => {
        const catA = this.getBookmarkCategory(a.name);
        const catB = this.getBookmarkCategory(b.name);
        if (catA !== catB) return catA.localeCompare(catB);
        return a.name.localeCompare(b.name);
      });
    } else if (this.selectedCategoryFilter !== 'All') {
      displayBookmarks = displayBookmarks.filter(b => this.getBookmarkCategory(b.name) === this.selectedCategoryFilter);
    }

    const draggedItem = displayBookmarks[this.draggedIndex];
    const targetItem = displayBookmarks[targetIndex];

    if (!draggedItem || !targetItem) {
      this._onBookmarkDragEnd();
      return;
    }

    const masterDragIndex = this.bookmarks.findIndex(b => b.id === draggedItem.id);
    let masterTargetIndex = this.bookmarks.findIndex(b => b.id === targetItem.id);

    if (masterDragIndex !== -1 && masterTargetIndex !== -1) {
      const updatedBookmarks = [...this.bookmarks];
      updatedBookmarks.splice(masterDragIndex, 1);
      masterTargetIndex = updatedBookmarks.findIndex(b => b.id === targetItem.id);
      updatedBookmarks.splice(masterTargetIndex, 0, draggedItem);
      
      this.bookmarks = updatedBookmarks;
      this.saveBookmarksToStorage();
    }

    this._onBookmarkDragEnd();
  }

  _onBookmarkDragEnd() {
    this.draggedBookmarkId = null;
    this.draggedIndex = null;
    this.dragOverIndex = null;
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

  setDirectionsTravelMode(mode: 'DRIVING' | 'WALKING' | 'TRANSIT') {
    this.directionsTravelMode = mode;
    if (this.manualOrigin.trim() && this.manualDestination.trim()) {
      this._handleDirections(this.manualOrigin.trim(), this.manualDestination.trim());
    }
  }

  onFlyDurationInput(e: Event) {
    this.flyDuration = Number((e.target as HTMLInputElement).value);
  }

  onTourDwellTimeInput(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    this.tourDwellTime = val;
    try {
      localStorage.setItem('gdm_map_tour_dwell', String(val));
    } catch (err) {
      console.error('Error saving tourDwellTime to localStorage:', err);
    }
  }

  getEasingFunction(type: 'sine' | 'cubic' | 'quintic' | 'linear'): (x: number) => number {
    switch (type) {
      case 'sine':
        return (x: number) => -(Math.cos(Math.PI * x) - 1) / 2;
      case 'cubic':
        return (x: number) => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
      case 'quintic':
        return (x: number) => x < 0.5 ? 16 * x * x * x * x * x : 1 - Math.pow(-2 * x + 2, 5) / 2;
      case 'linear':
      default:
        return (x: number) => x;
    }
  }

  onFlyEasingChange(e: Event) {
    const val = (e.target as HTMLSelectElement).value as 'sine' | 'cubic' | 'quintic' | 'linear';
    this.flyEasing = val;
    try {
      localStorage.setItem('gdm_map_fly_easing', val);
    } catch (err) {
      console.error('Error saving flyEasing to localStorage:', err);
    }
    this.requestUpdate();
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

    // Validation: check for URL-like strings or invalid characters
    const isUrl = /^(https?:\/\/|www\.)|(\.[a-zA-Z]{2,}\/)/i.test(cleanQuery) || /^[a-zA-Z0-9+.-]+:\/\//.test(cleanQuery);
    const hasHtml = /<[^>]*>/i.test(cleanQuery);
    const hasControlChars = /[\x00-\x1F\x7F-\x9F]/.test(cleanQuery);
    const tooLong = cleanQuery.length > 150; // safe limit for queries
    const isJunkSymbols = /([%#$`^&*+={}[\]|<>~_@])\1{2,}/.test(cleanQuery); // 3+ repeated weird symbols

    if (isUrl || hasHtml || hasControlChars || tooLong || isJunkSymbols) {
      console.warn('Recent search query failed validation. Skipping save to localStorage:', cleanQuery);
      return;
    }

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

    const tourBookmarks = this.getTourBookmarks();
    const flightStatus = this.isTourActive
      ? `Auto-Tour (${this.tourCurrentIndex + 1}/${tourBookmarks.length})`
      : (this.isOrbiting 
        ? 'Orbiting Target' 
        : (this.activeBookmarkId ? 'Scenic Flight' : 'Ready'));

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
              <span class="map-hud-pill-indicator ${this.isTourActive ? 'busy pulsed' : (this.isOrbiting ? 'busy' : 'active')}"></span>
              <span>Status: ${flightStatus}</span>
            </div>
          </div>

          ${this.isTourActive ? html`
            <div class="map-hud-tour-banner">
              <span class="tour-badge">TOUR MODE</span>
              <span class="tour-location-name">
                Visiting: <strong>${tourBookmarks[this.tourCurrentIndex]?.name || 'Next Destination'}</strong>
              </span>
              <button class="tour-hud-stop-btn" @click=${this.stopTour} title="Stop Tour">
                <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor">
                  <path d="M240-240v-480h480v480H240Z"/>
                </svg>
              </button>
            </div>
          ` : ''}
        </div>

        <!-- Flight progress indicator -->
        ${this.cameraFlightActive ? html`
          <div class="map-hud-flight-banner-container" style="
            position: absolute;
            top: 60px;
            left: 20px;
            z-index: 100;
            pointer-events: auto;
          ">
            <div class="map-hud-flight-banner" style="
              display: flex;
              flex-direction: column;
              gap: 6px;
              background: rgba(15, 23, 42, 0.85);
              backdrop-filter: blur(12px);
              border: 1px solid rgba(255, 255, 255, 0.15);
              border-radius: 12px;
              padding: 10px 16px;
              width: 320px;
              box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
              animation: slideInDown 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            ">
              <div style="display: flex; align-items: center; gap: 8px; justify-content: space-between;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span class="map-hud-pill-indicator busy pulsed" style="background-color: var(--color-accent, #0284c7);"></span>
                  <span style="font-size: 0.8rem; font-weight: 700; color: #f8fafc; letter-spacing: 0.05em; text-transform: uppercase;">
                    3D Camera Flight
                  </span>
                </div>
                <span style="font-family: monospace; font-size: 0.8rem; color: #38bdf8; font-weight: 700;">
                  ${Math.round(this.cameraFlightProgress)}%
                </span>
              </div>
              <div style="font-size: 0.85rem; color: #cbd5e1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px;">
                <span>To:</span>
                <strong style="color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${this.cameraFlightDestinationName}</strong>
              </div>
              <div style="width: 100%; height: 5px; background: rgba(255, 255, 255, 0.1); border-radius: 9999px; overflow: hidden; margin-top: 4px;">
                <div style="
                  height: 100%;
                  width: ${this.cameraFlightProgress}%;
                  background: linear-gradient(90deg, #0284c7 0%, #38bdf8 100%);
                  border-radius: 9999px;
                  transition: width 0.08s linear;
                "></div>
              </div>
            </div>
          </div>
        ` : ''}

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
        ${this.billingError
          ? html`<div
              class="absolute top-4 left-4 right-4 z-[9999] bg-amber-950/95 border-l-4 border-amber-500 rounded-r-xl shadow-2xl p-4 text-amber-100 flex items-start gap-4 backdrop-blur-md"
              role="alert"
              aria-live="polite"
            >
              <div class="text-2xl mt-0.5">⚠️</div>
              <div class="flex-1 min-w-0">
                <h4 class="font-bold text-amber-400 text-sm mb-1">Google Maps Billing Required</h4>
                <p class="text-xs text-amber-200/90 leading-relaxed">
                  The Google Maps Geocoding or Directions API returned a billing error. We have <strong>automatically enabled OpenStreetMap (Nominatim) fallbacks</strong> so you can still search locations and view flight arcs.
                </p>
                <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <a href="https://console.cloud.google.com/project/_/billing/enable" target="_blank" class="text-sky-400 hover:text-sky-300 underline font-medium">Enable Billing on Google Cloud</a>
                  <a href="https://developers.google.com/maps/gmp-get-started" target="_blank" class="text-sky-400 hover:text-sky-300 underline font-medium">Get Started Guide</a>
                </div>
              </div>
              <button 
                @click=${() => { this.billingError = ''; }} 
                class="text-amber-400 hover:text-amber-200 text-lg font-bold p-1 cursor-pointer focus:outline-none transition-colors bg-transparent border-none"
                aria-label="Dismiss warning"
              >
                &times;
              </button>
            </div>`
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
        <poi-details-card
          .poi=${this.selectedPoi}
          .isSaving=${this.poiSavingBookmarkId !== ''}
          @close=${() => { this.selectedPoi = null; }}
          @fly-to=${() => { if (this.selectedPoi) this.flyTo(this.selectedPoi.lat, this.selectedPoi.lng, 45, 0, 1000); }}
          @save-bookmark=${() => this.savePoiAsBookmark(this.selectedPoi)}
        ></poi-details-card>
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
          <button
            id="mcpTab"
            role="tab"
            aria-selected=${this.selectedChatTab === ChatTab.MCP_SERVER}
            aria-controls="mcp-panel"
            class=${classMap({
              'selected-tab': this.selectedChatTab === ChatTab.MCP_SERVER,
            })}
            @click=${() => {
              this.selectedChatTab = ChatTab.MCP_SERVER;
            }}>
            <!-- Terminal/Server Icon -->
            <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
              <path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H160v400Zm120-80h400v-80H280v80Zm0-120h400v-80H280v80ZM160-240v-400 400Z"/>
            </svg>
            <span>MCP Server</span>
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

                <!-- Travel Mode Selector -->
                <div style="display: flex; gap: 6px; margin: 4px 0 10px 0;">
                  <button 
                    type="button"
                    @click=${() => this.setDirectionsTravelMode('DRIVING')}
                    style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 6px; border-radius: 6px; border: 1px solid ${this.directionsTravelMode === 'DRIVING' ? 'var(--color-accent)' : 'var(--color-sidebar-border)'}; background: ${this.directionsTravelMode === 'DRIVING' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255, 255, 255, 0.03)'}; color: ${this.directionsTravelMode === 'DRIVING' ? 'var(--color-accent)' : 'var(--color-text2)'}; cursor: pointer; transition: all 0.2s;"
                    title="Driving Mode">
                    <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                      <path d="M240-160q-33 0-56.5-23.5T160-240v-320q0-33 23.5-56.5T240-640h480q33 0 56.5 23.5T800-560v320q0 33-23.5 56.5T720-160v40q0 17-11.5 28.5T680-80h-40q-17 0-28.5-11.5T600-120v-40H360v40q0 17-11.5 28.5T308-80h-40q-17 0-28.5-11.5T228-120v-40ZM240-560v160h480V-560H240Zm80 200q17 0 28.5-11.5T360-400q0-17-11.5-28.5T320-440q-17 0-28.5 11.5T280-400q0 17 11.5 28.5T320-360Zm320 0q17 0 28.5-11.5T680-400q0-17-11.5-28.5T640-440q-17 0-28.5 11.5T600-400q0 17 11.5 28.5T640-360Z"/>
                    </svg>
                    <span style="font-size: 0.75rem; font-weight: 600;">Drive</span>
                  </button>
                  <button 
                    type="button"
                    @click=${() => this.setDirectionsTravelMode('WALKING')}
                    style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 6px; border-radius: 6px; border: 1px solid ${this.directionsTravelMode === 'WALKING' ? '#10b981' : 'var(--color-sidebar-border)'}; background: ${this.directionsTravelMode === 'WALKING' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255, 255, 255, 0.03)'}; color: ${this.directionsTravelMode === 'WALKING' ? '#10b981' : 'var(--color-text2)'}; cursor: pointer; transition: all 0.2s;"
                    title="Walking Mode">
                    <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                      <path d="M480-680q33 0 56.5-23.5T560-760q0-33-23.5-56.5T480-840q-33 0-56.5 23.5T400-760q0 33 23.5 56.5T480-680ZM368-293l-48-239q-5-28 12-49.5t48-21.5q21 0 37.5 12.5T438-560l22 108q31 35 73.5 54.5T620-378v80q-54 0-98-25t-68-69l-14-72-48 240H220v-80h148Zm194-43q17 56 61.5 86T720-220v80q-73 0-130-39.5T502-286l-14-64-14 72H400l-4-22 36-180-64-32v-44q0-10 10-10h114q16 0 29 8t17 22l34 170Z"/>
                    </svg>
                    <span style="font-size: 0.75rem; font-weight: 600;">Walk</span>
                  </button>
                  <button 
                    type="button"
                    @click=${() => this.setDirectionsTravelMode('TRANSIT')}
                    style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 6px; border-radius: 6px; border: 1px solid ${this.directionsTravelMode === 'TRANSIT' ? '#a855f7' : 'var(--color-sidebar-border)'}; background: ${this.directionsTravelMode === 'TRANSIT' ? 'rgba(168, 85, 247, 0.15)' : 'rgba(255, 255, 255, 0.03)'}; color: ${this.directionsTravelMode === 'TRANSIT' ? '#a855f7' : 'var(--color-text2)'}; cursor: pointer; transition: all 0.2s;"
                    title="Transit Mode">
                    <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                      <path d="M280-80q-33 0-56.5-23.5T200-160v-40q0-17 11.5-28.5T240-240v-480q0-50 35-85t85-35h240q50 0 85 35t35 85v480q17 0 28.5 11.5T760-200v40q0 17-11.5 28.5T720-80h-40q-17 0-28.5-11.5T640-120v-40H320v40q0 17-11.5 28.5T280-80Zm80-640h240v-120H360v120Zm0 200h240v-120H360v120Zm0 240q17 0 28.5-11.5T400-320q0-17-11.5-28.5T360-360q-17 0-28.5 11.5T320-320q0 17 11.5 28.5T360-280Zm240 0q17 0 28.5-11.5T640-320q0-17-11.5-28.5T600-360q-17 0-28.5 11.5T560-320q0 17 11.5 28.5T600-280Z"/>
                    </svg>
                    <span style="font-size: 0.75rem; font-weight: 600;">Transit</span>
                  </button>
                </div>

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
              <div class="slider-ticks" style="margin-bottom: 12px;">
                <span>Fast (0.5s)</span>
                <span>Scenic (10s)</span>
              </div>

              <div class="slider-header" style="margin-top: 12px;">
                <h4 class="section-label">📈 Flight Easing Curve</h4>
              </div>
              <select 
                class="settings-select"
                @change=${this.onFlyEasingChange}
                .value=${this.flyEasing}>
                <option value="sine">🌊 Ease In Out (Sine - Organic)</option>
                <option value="cubic">🚀 Ease In Out (Cubic - Dynamic)</option>
                <option value="quintic">☄️ Ease In Out (Quintic - Cinematic)</option>
                <option value="linear">📏 Linear (Mechanical)</option>
              </select>

              <div class="slider-header" style="margin-top: 16px;">
                <h4 class="section-label">⏱️ Tour Pause Duration</h4>
                <span class="value-display">${(this.tourDwellTime / 1000).toFixed(1)}s</span>
              </div>
              <input
                type="range"
                class="settings-slider"
                min="1000"
                max="15000"
                step="500"
                .value=${this.tourDwellTime}
                @input=${this.onTourDwellTimeInput} />
              <div class="slider-ticks">
                <span>Quick (1s)</span>
                <span>Long (15s)</span>
              </div>

              <!-- Smart Route Path Optimization -->
              <div class="checkbox-container" style="margin-top: 14px;">
                <input 
                  type="checkbox" 
                  id="optimizeTourPathToggle"
                  ?checked=${this.optimizeTourPath}
                  @change=${this.toggleOptimizeTourPath} />
                <label for="optimizeTourPathToggle" style="font-weight: 500; display: flex; align-items: center; gap: 4px;">
                  <span>🛣️ Smart-Route Scattered Bookmarks</span>
                </label>
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
                          <bookmark-card
                            .bookmark=${b}
                            .isActive=${this.activeBookmarkId === b.id}
                            .isEditing=${this.editingBookmarkId === b.id}
                            .editingName=${this.editingBookmarkName}
                            .isNewlyAdded=${this.lastAddedBookmarkId === b.id}
                            .isLoadingPhoto=${this.loadingPhotoBookmarkIds.has(b.id)}
                            .category=${category}
                            .emoji=${emoji}
                            .index=${index}
                            @fly-to=${() => this.flyTo(b.lat, b.lng, b.tilt, b.heading, b.range, b.id)}
                            @start-edit=${(e: any) => this.startEditingBookmark(e.detail.id, e.detail.name)}
                            @save-edit=${(e: any) => { this.editingBookmarkName = e.detail.name; this.saveBookmarkName(e.detail.id); }}
                            @cancel-edit=${() => this.cancelEditingBookmark()}
                            @delete=${(e: any) => this.deleteBookmark(e.detail.id)}
                            @share=${(e: any) => this.shareBookmark(e.detail.bookmark)}
                            @fetch-photo=${(e: any) => this.fetchPhotoForBookmark(e.detail.id)}
                            @name-input=${(e: any) => { this.editingBookmarkName = e.detail.value; }}
                            class="bookmark-item ${this.activeBookmarkId === b.id ? 'active' : ''} cat-${category.toLowerCase()} ${this.lastAddedBookmarkId === b.id ? 'newly-added' : ''} ${this.draggedBookmarkId === b.id ? 'dragging' : ''} ${this.dragOverIndex === index ? 'drag-over' : ''}" 
                            id="bookmark-${b.id}" 
                            style="--stagger-delay: ${index * 60}ms;"
                            draggable="true"
                            @dragstart=${(e: DragEvent) => this._onBookmarkDragStart(e, b.id, index)}
                            @dragover=${(e: DragEvent) => this._onBookmarkDragOver(e, index)}
                            @dragend=${() => this._onBookmarkDragEnd()}
                            @drop=${(e: DragEvent) => this._onBookmarkDrop(e, index)}
                          ></bookmark-card>
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
              
              <div class="weather-unit-setting">
                <span class="weather-unit-label">Temperature Unit</span>
                <div class="weather-unit-segmented">
                  <button 
                    class="weather-unit-btn ${this.weatherUnit === 'C' ? 'active' : ''}"
                    @click=${() => this.setWeatherUnit('C')}
                    title="Display in Celsius"
                  >
                    °C
                  </button>
                  <button 
                    class="weather-unit-btn ${this.weatherUnit === 'F' ? 'active' : ''}"
                    @click=${() => this.setWeatherUnit('F')}
                    title="Display in Fahrenheit"
                  >
                    °F
                  </button>
                </div>
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

                <!-- POI Category Filter Segmented Group -->
                <div style="margin-top: 14px; padding-left: 24px;">
                  <span style="font-size: 0.8rem; color: var(--color-text2); display: block; margin-bottom: 6px;">Category Filter</span>
                  <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px;">
                    <button 
                      class="poi-filter-btn ${this.poiCategoryFilter === 'all' ? 'active' : ''}"
                      style="border-color: ${this.poiCategoryFilter === 'all' ? 'var(--color-accent)' : 'var(--color-sidebar-border)'};"
                      @click=${() => this.onPoiCategorySelect('all')}>
                      🌟 All
                    </button>
                    <button 
                      class="poi-filter-btn ${this.poiCategoryFilter === 'museums' ? 'active' : ''}"
                      style="border-color: ${this.poiCategoryFilter === 'museums' ? 'var(--color-accent)' : 'var(--color-sidebar-border)'};"
                      @click=${() => this.onPoiCategorySelect('museums')}>
                      🏛️ Museums
                    </button>
                    <button 
                      class="poi-filter-btn ${this.poiCategoryFilter === 'parks' ? 'active' : ''}"
                      style="border-color: ${this.poiCategoryFilter === 'parks' ? 'var(--color-accent)' : 'var(--color-sidebar-border)'};"
                      @click=${() => this.onPoiCategorySelect('parks')}>
                      🌳 Parks
                    </button>
                    <button 
                      class="poi-filter-btn ${this.poiCategoryFilter === 'religious' ? 'active' : ''}"
                      style="border-color: ${this.poiCategoryFilter === 'religious' ? 'var(--color-accent)' : 'var(--color-sidebar-border)'};"
                      @click=${() => this.onPoiCategorySelect('religious')}>
                      ⛪ Religious
                    </button>
                  </div>
                </div>

                <!-- POI Custom Search Input -->
                <div style="margin-top: 14px; padding-left: 24px;">
                  <span style="font-size: 0.8rem; color: var(--color-text2); display: block; margin-bottom: 6px;">Custom Search Query</span>
                  <div class="settings-input-group">
                    <div style="position: relative; flex: 1; display: flex; align-items: center;">
                      <input 
                        type="text" 
                        class="settings-input"
                        style="width: 100%; padding-right: 32px;"
                        placeholder="e.g. coffee shop, beach, library" 
                        .value=${this.poiCustomSearchQuery}
                        @keydown=${(e: KeyboardEvent) => {
                          if (e.key === 'Enter') {
                            const val = (e.target as HTMLInputElement).value;
                            this.onPoiCustomSearch(val);
                          }
                        }}
                      />
                      ${this.poiCustomSearchQuery ? html`
                        <button 
                          @click=${this.clearPoiCustomSearch}
                          style="position: absolute; right: 8px; background: transparent; border: none; color: var(--color-text3); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 2px;"
                          title="Clear search">
                          <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor">
                            <path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/>
                          </svg>
                        </button>
                      ` : html`
                        <span style="position: absolute; right: 10px; color: var(--color-text3); pointer-events: none; display: flex; align-items: center;">
                          <svg xmlns="http://www.w3.org/2000/svg" height="14px" viewBox="0 -960 960 960" width="14px" fill="currentColor">
                            <path d="M784-120 533-371q-30 24-74 37.5T368-320q-115 0-195.5-80.5T92-596q0-115 80.5-195.5T368-872q115 0 195.5 80.5T644-596q0 45-13.5 89T593-433l251 251-60 62ZM368-400q80 0 136-56t56-136q0-80-56-136t-136-56q-80 0-136 56t-56 136q0 80 56 136t136 56Z"/>
                          </svg>
                        </span>
                      `}
                    </div>
                    <button 
                      class="settings-button"
                      style="flex-shrink: 0;"
                      @click=${(e: Event) => {
                        const inputEl = (e.currentTarget as HTMLElement).previousElementSibling?.querySelector('input') as HTMLInputElement;
                        if (inputEl) {
                          this.onPoiCustomSearch(inputEl.value);
                        }
                      }}>
                      Search
                    </button>
                  </div>
                </div>
              ` : ''}

              ${this.poiLoading ? html`<div style="font-size: 0.75rem; color: var(--color-text3); margin-top: 8px; padding-left: 24px;">Finding POIs...</div>` : ''}
            </div>

          </div>
        </div>

        <div
          id="mcp-panel"
          role="tabpanel"
          aria-labelledby="mcpTab"
          class=${classMap({
            'tabcontent': true,
            'showtab': this.selectedChatTab === ChatTab.MCP_SERVER,
          })}>
          <div class="settings-container">
            <h3 class="settings-title" style="display: flex; align-items: center; gap: 8px;">
              <span>🤖</span> MCP Server Control
            </h3>
            
            <!-- Connection Status -->
            <div class="settings-section">
              <h4 class="section-label" style="display: flex; align-items: center; gap: 6px; margin-bottom: 8px;">
                <span style="display: inline-block; width: 8px; height: 8px; background-color: #10b981; border-radius: 50%; box-shadow: 0 0 8px #10b981;"></span>
                <span>Active Map Server Connection</span>
              </h4>
              <div style="background-color: var(--color-sidebar-bg-alt, rgba(0,0,0,0.03)); border: 1px solid var(--color-sidebar-border); border-radius: 8px; padding: 12px; margin-top: 4px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                  <span style="font-size: 0.8rem; font-weight: 600; color: var(--color-text1);">AI Studio Google Map Server</span>
                  <span style="font-size: 0.65rem; font-weight: 600; color: #10b981; background-color: rgba(16, 185, 129, 0.1); padding: 1px 6px; border-radius: 9999px;">
                    ONLINE
                  </span>
                </div>
                <div style="font-size: 0.72rem; color: var(--color-text2); line-height: 1.5; display: flex; flex-direction: column; gap: 2px;">
                  <div><strong>Protocol version:</strong> v2024-11-05</div>
                  <div><strong>Link transport:</strong> InMemory (Client-Linked)</div>
                  <div><strong>Registered tools:</strong> 7 Active Schemas</div>
                </div>
              </div>
            </div>

            <!-- Exposed Tools Inspector -->
            <div class="settings-section">
              <h4 class="section-label">🛠️ Exposed Schemas & Simulators</h4>
              <p style="font-size: 0.7rem; color: var(--color-text3); margin-top: 2px; margin-bottom: 10px; line-height: 1.3;">
                Click any simulator button below to execute the tool locally and check its behavior.
              </p>
              
              <div style="display: flex; flex-direction: column; gap: 8px;">
                <!-- Tool 1: View Location -->
                <details style="background-color: var(--color-sidebar-bg-alt, rgba(0,0,0,0.02)); border: 1px solid var(--color-sidebar-border); border-radius: 6px; padding: 8px;">
                  <summary style="font-size: 0.75rem; font-weight: 600; cursor: pointer; color: var(--color-text1); user-select: none; outline: none; list-style: none; display: flex; align-items: center; justify-content: space-between;">
                    <span style="font-family: monospace; color: var(--color-accent);">view_location_google_maps</span>
                    <span style="font-size: 0.65rem; color: var(--color-text3);">▶</span>
                  </summary>
                  <div style="font-size: 0.7rem; color: var(--color-text2); margin-top: 6px; line-height: 1.3; border-top: 1px dashed var(--color-sidebar-border); padding-top: 6px;">
                    <div style="margin-bottom: 4px;"><strong>Description:</strong> View a specific query or geographical location.</div>
                    <div style="margin-bottom: 6px;"><strong>Arguments schema:</strong> <code>{ query: string }</code></div>
                    <button class="settings-button" style="font-size: 0.65rem; padding: 4px 8px; height: auto; width: 100%; text-align: center; justify-content: center;" @click=${() => this.handleMapQuery({ location: "Paris, France", _toolCallName: 'view_location_google_maps', _toolCallArgs: { query: "Paris, France" } })}>
                      ⚡ Simulate: Fly to Paris, France
                    </button>
                  </div>
                </details>

                <!-- Tool 2: Directions -->
                <details style="background-color: var(--color-sidebar-bg-alt, rgba(0,0,0,0.02)); border: 1px solid var(--color-sidebar-border); border-radius: 6px; padding: 8px;">
                  <summary style="font-size: 0.75rem; font-weight: 600; cursor: pointer; color: var(--color-text1); user-select: none; outline: none; list-style: none; display: flex; align-items: center; justify-content: space-between;">
                    <span style="font-family: monospace; color: var(--color-accent);">directions_on_google_maps</span>
                    <span style="font-size: 0.65rem; color: var(--color-text3);">▶</span>
                  </summary>
                  <div style="font-size: 0.7rem; color: var(--color-text2); margin-top: 6px; line-height: 1.3; border-top: 1px dashed var(--color-sidebar-border); padding-top: 6px;">
                    <div style="margin-bottom: 4px;"><strong>Description:</strong> Search directions from origin to destination.</div>
                    <div style="margin-bottom: 6px;"><strong>Arguments schema:</strong> <code>{ origin: string, destination: string }</code></div>
                    <button class="settings-button" style="font-size: 0.65rem; padding: 4px 8px; height: auto; width: 100%; text-align: center; justify-content: center;" @click=${() => this.handleMapQuery({ origin: "San Francisco", destination: "Los Angeles", _toolCallName: 'directions_on_google_maps', _toolCallArgs: { origin: "San Francisco", destination: "Los Angeles" } })}>
                      ⚡ Simulate: Directions SF to LA
                    </button>
                  </div>
                </details>

                <!-- Tool 3: Weather -->
                <details style="background-color: var(--color-sidebar-bg-alt, rgba(0,0,0,0.02)); border: 1px solid var(--color-sidebar-border); border-radius: 6px; padding: 8px;">
                  <summary style="font-size: 0.75rem; font-weight: 600; cursor: pointer; color: var(--color-text1); user-select: none; outline: none; list-style: none; display: flex; align-items: center; justify-content: space-between;">
                    <span style="font-family: monospace; color: var(--color-accent);">toggle_weather_overlay</span>
                    <span style="font-size: 0.65rem; color: var(--color-text3);">▶</span>
                  </summary>
                  <div style="font-size: 0.7rem; color: var(--color-text2); margin-top: 6px; line-height: 1.3; border-top: 1px dashed var(--color-sidebar-border); padding-top: 6px;">
                    <div style="margin-bottom: 4px;"><strong>Description:</strong> Enable/disable live weather layer overlay.</div>
                    <div style="margin-bottom: 6px;"><strong>Arguments schema:</strong> <code>{ enable: boolean }</code></div>
                    <div style="display: flex; gap: 4px;">
                      <button class="settings-button" style="font-size: 0.65rem; padding: 4px 8px; height: auto; flex: 1; text-align: center; justify-content: center;" @click=${() => this.handleMapQuery({ weather: true, _toolCallName: 'toggle_weather_overlay', _toolCallArgs: { enable: true } })}>
                        Enable Overlay
                      </button>
                      <button class="settings-button" style="font-size: 0.65rem; padding: 4px 8px; height: auto; flex: 1; background-color: transparent; border: 1px solid var(--color-sidebar-border); color: var(--color-text2); text-align: center; justify-content: center;" @click=${() => this.handleMapQuery({ weather: false, _toolCallName: 'toggle_weather_overlay', _toolCallArgs: { enable: false } })}>
                        Disable Overlay
                      </button>
                    </div>
                  </div>
                </details>

                <!-- Tool 4: POIs -->
                <details style="background-color: var(--color-sidebar-bg-alt, rgba(0,0,0,0.02)); border: 1px solid var(--color-sidebar-border); border-radius: 6px; padding: 8px;">
                  <summary style="font-size: 0.75rem; font-weight: 600; cursor: pointer; color: var(--color-text1); user-select: none; outline: none; list-style: none; display: flex; align-items: center; justify-content: space-between;">
                    <span style="font-family: monospace; color: var(--color-accent);">toggle_poi_markers</span>
                    <span style="font-size: 0.65rem; color: var(--color-text3);">▶</span>
                  </summary>
                  <div style="font-size: 0.7rem; color: var(--color-text2); margin-top: 6px; line-height: 1.3; border-top: 1px dashed var(--color-sidebar-border); padding-top: 6px;">
                    <div style="margin-bottom: 4px;"><strong>Description:</strong> Show/hide nearby local points of interest.</div>
                    <div style="margin-bottom: 6px;"><strong>Arguments schema:</strong> <code>{ enable: boolean, radius?: number, category?: string }</code></div>
                    <div style="display: flex; gap: 4px;">
                      <button class="settings-button" style="font-size: 0.65rem; padding: 4px 8px; height: auto; flex: 1; text-align: center; justify-content: center;" @click=${() => this.handleMapQuery({ poi: { enable: true, radius: 2000, category: 'museums' }, _toolCallName: 'toggle_poi_markers', _toolCallArgs: { enable: true, radius: 2000, category: 'museums' } })}>
                        Show Museums
                      </button>
                      <button class="settings-button" style="font-size: 0.65rem; padding: 4px 8px; height: auto; flex: 1; background-color: transparent; border: 1px solid var(--color-sidebar-border); color: var(--color-text2); text-align: center; justify-content: center;" @click=${() => this.handleMapQuery({ poi: { enable: false }, _toolCallName: 'toggle_poi_markers', _toolCallArgs: { enable: false } })}>
                        Hide POIs
                      </button>
                    </div>
                  </div>
                </details>

                <!-- Tool 5: Camera -->
                <details style="background-color: var(--color-sidebar-bg-alt, rgba(0,0,0,0.02)); border: 1px solid var(--color-sidebar-border); border-radius: 6px; padding: 8px;">
                  <summary style="font-size: 0.75rem; font-weight: 600; cursor: pointer; color: var(--color-text1); user-select: none; outline: none; list-style: none; display: flex; align-items: center; justify-content: space-between;">
                    <span style="font-family: monospace; color: var(--color-accent);">set_map_camera</span>
                    <span style="font-size: 0.65rem; color: var(--color-text3);">▶</span>
                  </summary>
                  <div style="font-size: 0.7rem; color: var(--color-text2); margin-top: 6px; line-height: 1.3; border-top: 1px dashed var(--color-sidebar-border); padding-top: 6px;">
                    <div style="margin-bottom: 4px;"><strong>Description:</strong> Programmatically rotate or tilt the 3D camera.</div>
                    <div style="margin-bottom: 6px;"><strong>Arguments schema:</strong> <code>{ tilt?: number, heading?: number, range?: number }</code></div>
                    <button class="settings-button" style="font-size: 0.65rem; padding: 4px 8px; height: auto; width: 100%; text-align: center; justify-content: center;" @click=${() => this.handleMapQuery({ camera: { tilt: 70, heading: 270, range: 1500 }, _toolCallName: 'set_map_camera', _toolCallArgs: { tilt: 70, heading: 270, range: 1500 } })}>
                      ⚡ Simulate: Tilt 70° facing West
                    </button>
                  </div>
                </details>

                <!-- Tool 6: Bookmarks -->
                <details style="background-color: var(--color-sidebar-bg-alt, rgba(0,0,0,0.02)); border: 1px solid var(--color-sidebar-border); border-radius: 6px; padding: 8px;">
                  <summary style="font-size: 0.75rem; font-weight: 600; cursor: pointer; color: var(--color-text1); user-select: none; outline: none; list-style: none; display: flex; align-items: center; justify-content: space-between;">
                    <span style="font-family: monospace; color: var(--color-accent);">manage_bookmarks</span>
                    <span style="font-size: 0.65rem; color: var(--color-text3);">▶</span>
                  </summary>
                  <div style="font-size: 0.7rem; color: var(--color-text2); margin-top: 6px; line-height: 1.3; border-top: 1px dashed var(--color-sidebar-border); padding-top: 6px;">
                    <div style="margin-bottom: 4px;"><strong>Description:</strong> Programmatically save bookmarks or list them.</div>
                    <div style="margin-bottom: 6px;"><strong>Arguments schema:</strong> <code>{ action: "add"|"list", name?: string }</code></div>
                    <button class="settings-button" style="font-size: 0.65rem; padding: 4px 8px; height: auto; width: 100%; text-align: center; justify-content: center;" @click=${() => this.handleMapQuery({ bookmark: { action: 'add', name: '🤖 AI Saved Landmark' }, _toolCallName: 'manage_bookmarks', _toolCallArgs: { action: 'add', name: 'AI Saved Landmark' } })}>
                      ⚡ Simulate: Save Current View
                    </button>
                  </div>
                </details>

                <!-- Tool 7: Tour -->
                <details style="background-color: var(--color-sidebar-bg-alt, rgba(0,0,0,0.02)); border: 1px solid var(--color-sidebar-border); border-radius: 6px; padding: 8px;">
                  <summary style="font-size: 0.75rem; font-weight: 600; cursor: pointer; color: var(--color-text1); user-select: none; outline: none; list-style: none; display: flex; align-items: center; justify-content: space-between;">
                    <span style="font-family: monospace; color: var(--color-accent);">manage_tour</span>
                    <span style="font-size: 0.65rem; color: var(--color-text3);">▶</span>
                  </summary>
                  <div style="font-size: 0.7rem; color: var(--color-text2); margin-top: 6px; line-height: 1.3; border-top: 1px dashed var(--color-sidebar-border); padding-top: 6px;">
                    <div style="margin-bottom: 4px;"><strong>Description:</strong> Start or stop the auto-tour through bookmarks.</div>
                    <div style="margin-bottom: 6px;"><strong>Arguments schema:</strong> <code>{ action: "play"|"stop" }</code></div>
                    <div style="display: flex; gap: 4px;">
                      <button class="settings-button" style="font-size: 0.65rem; padding: 4px 8px; height: auto; flex: 1; text-align: center; justify-content: center;" @click=${() => this.handleMapQuery({ tour: { action: 'play' }, _toolCallName: 'manage_tour', _toolCallArgs: { action: 'play' } })}>
                        Play Tour
                      </button>
                      <button class="settings-button" style="font-size: 0.65rem; padding: 4px 8px; height: auto; flex: 1; background-color: transparent; border: 1px solid var(--color-sidebar-border); color: var(--color-text2); text-align: center; justify-content: center;" @click=${() => this.handleMapQuery({ tour: { action: 'stop' }, _toolCallName: 'manage_tour', _toolCallArgs: { action: 'stop' } })}>
                        Stop Tour
                      </button>
                    </div>
                  </div>
                </details>
              </div>
            </div>

            <!-- Transaction Log -->
            <div class="settings-section">
              <h4 class="section-label" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                <span>📜 Real-Time Transaction Log</span>
                ${this.mcpLogs.length > 0 ? html`
                  <button @click=${() => { this.mcpLogs = []; this.requestUpdate(); }} style="background: transparent; border: none; font-size: 0.65rem; color: var(--color-accent); cursor: pointer; padding: 2px 4px;">
                    Clear logs
                  </button>
                ` : ''}
              </h4>
              
              ${this.mcpLogs.length === 0 ? html`
                <div style="text-align: center; padding: 18px 10px; border: 1px dashed var(--color-sidebar-border); border-radius: 8px; color: var(--color-text3); font-size: 0.72rem; margin-top: 6px;">
                  No transactions recorded yet. Ask Gemini to adjust the map or click a simulation button above!
                </div>
              ` : html`
                <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px; max-height: 280px; overflow-y: auto; padding-right: 2px;">
                  ${this.mcpLogs.map(log => {
                    const timeStr = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    return html`
                      <div style="background-color: var(--color-sidebar-bg-alt, rgba(0,0,0,0.03)); border: 1px solid var(--color-sidebar-border); border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 4px;">
                        <div style="display: flex; align-items: center; justify-content: space-between;">
                          <span style="font-family: monospace; font-size: 0.7rem; font-weight: 600; color: var(--color-accent);">${log.name}</span>
                          <span style="font-size: 0.65rem; color: var(--color-text3);">${timeStr}</span>
                        </div>
                        <div style="background-color: rgba(0,0,0,0.04); padding: 4px 6px; border-radius: 4px; font-family: monospace; font-size: 0.65rem; color: var(--color-text2); overflow-x: auto; white-space: pre-wrap; word-break: break-all;">${JSON.stringify(log.args, null, 2)}</div>
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 2px; border-top: 1px dashed var(--color-sidebar-border); padding-top: 4px;">
                          <span style="display: flex; align-items: center; gap: 4px; font-size: 0.65rem; font-weight: 600; color: #10b981;">
                            ✅ Success
                          </span>
                          <button class="settings-button" style="font-size: 0.6rem; padding: 2px 6px; height: auto;" @click=${() => this.handleMapQuery({ ...log.args, _toolCallName: log.name, _toolCallArgs: log.args })}>
                            Replay Call
                          </button>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `}
            </div>

          </div>
        </div>
      </div>
    </div>`;
  }
}
