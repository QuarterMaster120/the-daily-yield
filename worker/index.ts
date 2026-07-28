/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { digestMonitorHealth, handleOutlookInternal, runDailyWatchdog, runFirstAmericanPrefetch, runScheduledDigest, type OutlookDigestEnv } from "./outlook-digest";

interface Env extends OutlookDigestEnv {
  ASSETS: Fetcher;
  BROWSER: BrowserWorker;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/system-health" && request.method === "GET") {
      const health = await digestMonitorHealth(env);
      return Response.json(health, { status: health.status === "healthy" ? 200 : 503, headers: { "Cache-Control": "no-store" } });
    }

    const internalResponse = await handleOutlookInternal(request, env);
    if (internalResponse) return internalResponse;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      try {
        await runFirstAmericanPrefetch(env, controller.scheduledTime);
      } catch (error) {
        // Keep the subscriber email on schedule; the watchdog records a stale
        // First American observation as a failed health check at 5:20 AM ET.
        console.error(JSON.stringify({ event: "first_american_prefetch_failed", error: error instanceof Error ? error.message : String(error) }));
      }
      await runScheduledDigest(env, controller.scheduledTime);
    })());
    ctx.waitUntil(runDailyWatchdog(env, controller.scheduledTime));
  },
};

export default worker;
