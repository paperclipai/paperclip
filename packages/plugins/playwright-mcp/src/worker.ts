import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import { chromium, type Browser, type Page, type BrowserContext } from "playwright";

// Store browser instances
let browserInstance: { browser: Browser; context: BrowserContext; page: Page } | null = null;

async function getOrCreateBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  if (!browserInstance || !browserInstance.browser.isConnected()) {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    
    browserInstance = { browser, context, page };
  }
  
  return browserInstance;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Playwright MCP plugin initializing");

    // Tool: browser_navigate
    ctx.tools.register(
      "browser_navigate",
      {
        displayName: "Navigate Browser",
        description: "Navigate to a URL in the browser",
        parametersSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to navigate to" },
            waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"], default: "load" }
          },
          required: ["url"]
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const { page } = await getOrCreateBrowser();
        const waitUntil = params.waitUntil || "load";
        
        const response = await page.goto(params.url, { waitUntil: waitUntil as any, timeout: 30000 });
        
        return {
          content: JSON.stringify({
            success: true,
            url: page.url(),
            title: await page.title(),
            status: response?.status()
          })
        };
      }
    );

    // Tool: browser_click
    ctx.tools.register(
      "browser_click",
      {
        displayName: "Click Element",
        description: "Click an element on the page using CSS selector",
        parametersSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector for the element to click" },
            waitForNavigation: { type: "boolean", default: false }
          },
          required: ["selector"]
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const { page } = await getOrCreateBrowser();
        
        if (params.waitForNavigation) {
          await Promise.all([
            page.waitForNavigation({ timeout: 30000 }),
            page.click(params.selector)
          ]);
        } else {
          await page.click(params.selector, { timeout: 10000 });
        }
        
        return {
          content: JSON.stringify({
            success: true,
            url: page.url()
          })
        };
      }
    );

    // Tool: browser_fill
    ctx.tools.register(
      "browser_fill",
      {
        displayName: "Fill Form Field",
        description: "Fill a form field with text",
        parametersSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector for the input field" },
            value: { type: "string", description: "The value to fill in" },
            clear: { type: "boolean", default: true }
          },
          required: ["selector", "value"]
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const { page } = await getOrCreateBrowser();
        
        if (params.clear !== false) {
          await page.fill(params.selector, params.value);
        } else {
          await page.type(params.selector, params.value);
        }
        
        return {
          content: JSON.stringify({
            success: true
          })
        };
      }
    );

    // Tool: browser_screenshot
    ctx.tools.register(
      "browser_screenshot",
      {
        displayName: "Take Screenshot",
        description: "Take a screenshot of the current page",
        parametersSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector to screenshot specific element" },
            fullPage: { type: "boolean", default: false }
          }
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const { page } = await getOrCreateBrowser();
        
        let screenshot: Buffer;
        
        if (params.selector) {
          const element = await page.$(params.selector);
          if (!element) {
            return { content: JSON.stringify({ success: false, error: "Element not found" }) };
          }
          screenshot = await element.screenshot() as Buffer;
        } else {
          screenshot = await page.screenshot({ fullPage: params.fullPage || false }) as Buffer;
        }
        
        return {
          content: JSON.stringify({
            success: true,
            screenshot: screenshot.toString("base64"),
            format: "png"
          })
        };
      }
    );

    // Tool: browser_extract
    ctx.tools.register(
      "browser_extract",
      {
        displayName: "Extract Data",
        description: "Extract data from the page using CSS selectors",
        parametersSchema: {
          type: "object",
          properties: {
            selectors: { type: "object", description: "Key-value pairs of field names and CSS selectors" }
          },
          required: ["selectors"]
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const { page } = await getOrCreateBrowser();
        
        const result: Record<string, any> = {};
        
        for (const [key, selector] of Object.entries(params.selectors)) {
          try {
            const element = await page.$(selector as string);
            if (element) {
              result[key] = await element.textContent() || await element.getAttribute("value") || "";
            } else {
              result[key] = null;
            }
          } catch (e) {
            result[key] = null;
          }
        }
        
        return {
          content: JSON.stringify({
            success: true,
            data: result
          })
        };
      }
    );

    // Tool: browser_evaluate
    ctx.tools.register(
      "browser_evaluate",
      {
        displayName: "Evaluate JavaScript",
        description: "Execute JavaScript in the browser context",
        parametersSchema: {
          type: "object",
          properties: {
            script: { type: "string", description: "JavaScript code to execute" }
          },
          required: ["script"]
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const { page } = await getOrCreateBrowser();
        
        const result = await page.evaluate(params.script);
        
        return {
          content: JSON.stringify({
            success: true,
            result
          })
        };
      }
    );

    // Tool: browser_wait_for
    ctx.tools.register(
      "browser_wait_for",
      {
        displayName: "Wait For Element",
        description: "Wait for an element to appear on the page",
        parametersSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector for the element" },
            timeout: { type: "number", default: 30000 },
            state: { type: "string", enum: ["attached", "detached", "visible", "hidden"], default: "visible" }
          },
          required: ["selector"]
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const { page } = await getOrCreateBrowser();
        
        await page.waitForSelector(params.selector, {
          state: params.state || "visible",
          timeout: params.timeout || 30000
        });
        
        return {
          content: JSON.stringify({
            success: true
          })
        };
      }
    );

    // Tool: browser_get_url
    ctx.tools.register(
      "browser_get_url",
      {
        displayName: "Get Current URL",
        description: "Get the current page URL",
        parametersSchema: {
          type: "object",
          properties: {}
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const { page } = await getOrCreateBrowser();
        
        return {
          content: JSON.stringify({
            success: true,
            url: page.url()
          })
        };
      }
    );

    // Tool: browser_get_title
    ctx.tools.register(
      "browser_get_title",
      {
        displayName: "Get Page Title",
        description: "Get the current page title",
        parametersSchema: {
          type: "object",
          properties: {}
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        const { page } = await getOrCreateBrowser();
        
        return {
          content: JSON.stringify({
            success: true,
            title: await page.title()
          })
        };
      }
    );

    // Tool: browser_close
    ctx.tools.register(
      "browser_close",
      {
        displayName: "Close Browser",
        description: "Close the browser instance",
        parametersSchema: {
          type: "object",
          properties: {}
        }
      },
      async (params: any, runCtx): Promise<ToolResult> => {
        if (browserInstance) {
          await browserInstance.browser.close();
          browserInstance = null;
        }
        
        return {
          content: JSON.stringify({
            success: true,
            message: "Browser closed"
          })
        };
      }
    );

    ctx.logger.info("Playwright MCP plugin initialized with 10 tools registered");
  },

  async onHealth() {
    return { status: "ok", message: "Playwright MCP plugin is healthy", browserActive: browserInstance !== null };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
