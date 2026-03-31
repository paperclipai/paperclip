/**
 * Playwright MCP Plugin Manifest
 *
 * Browser automation plugin using Playwright MCP.
 * Enables agents to navigate, interact, and extract data from web pages.
 */

import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "playwright.mcp",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Playwright MCP",
  description: "Browser automation plugin using Playwright MCP. Navigate pages, click elements, fill forms, take screenshots, and extract data from web pages.",
  author: "Paperclip AI",
  categories: ["automation", "connector"],

  // Capabilities required by this plugin
  capabilities: [
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "events.emit",
  ],

  // Worker entrypoint
  entrypoints: {
    worker: "./dist/worker.js",
  },

  // Agent tools contributed by this plugin
  tools: [
    {
      name: "browser_navigate",
      displayName: "Navigate Browser",
      description: "Navigate to a URL in the browser",
      parametersSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to navigate to"
          },
          waitUntil: {
            type: "string",
            enum: ["load", "domcontentloaded", "networkidle"],
            default: "load",
            description: "When to consider navigation complete"
          }
        },
        required: ["url"]
      }
    },
    {
      name: "browser_click",
      displayName: "Click Element",
      description: "Click an element on the page using CSS selector",
      parametersSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector for the element to click"
          },
          waitForNavigation: {
            type: "boolean",
            default: false,
            description: "Wait for navigation after click"
          }
        },
        required: ["selector"]
      }
    },
    {
      name: "browser_fill",
      displayName: "Fill Form Field",
      description: "Fill a form field with text",
      parametersSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector for the input field"
          },
          value: {
            type: "string",
            description: "The value to fill in"
          },
          clear: {
            type: "boolean",
            default: true,
            description: "Clear the field before filling"
          }
        },
        required: ["selector", "value"]
      }
    },
    {
      name: "browser_screenshot",
      displayName: "Take Screenshot",
      description: "Take a screenshot of the current page",
      parametersSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector to screenshot specific element (optional)"
          },
          fullPage: {
            type: "boolean",
            default: false,
            description: "Take full page screenshot"
          }
        }
      }
    },
    {
      name: "browser_extract",
      displayName: "Extract Data",
      description: "Extract data from the page using CSS selectors",
      parametersSchema: {
        type: "object",
        properties: {
          selectors: {
            type: "object",
            description: "Key-value pairs of field names and CSS selectors",
            additionalProperties: { type: "string" }
          }
        },
        required: ["selectors"]
      }
    },
    {
      name: "browser_evaluate",
      displayName: "Evaluate JavaScript",
      description: "Execute JavaScript in the browser context",
      parametersSchema: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description: "JavaScript code to execute"
          }
        },
        required: ["script"]
      }
    },
    {
      name: "browser_wait_for",
      displayName: "Wait For Element",
      description: "Wait for an element to appear on the page",
      parametersSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector for the element"
          },
          timeout: {
            type: "number",
            default: 30000,
            description: "Timeout in milliseconds"
          },
          state: {
            type: "string",
            enum: ["attached", "detached", "visible", "hidden"],
            default: "visible",
            description: "Wait for element state"
          }
        },
        required: ["selector"]
      }
    },
    {
      name: "browser_get_url",
      displayName: "Get Current URL",
      description: "Get the current page URL",
      parametersSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "browser_get_title",
      displayName: "Get Page Title",
      description: "Get the current page title",
      parametersSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "browser_close",
      displayName: "Close Browser",
      description: "Close the browser instance",
      parametersSchema: {
        type: "object",
        properties: {}
      }
    }
  ]
};

export default manifest;
