/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { digestMonitorHealth, handleOutlookInternal, runDailyWatchdog, runFifthThirdPrefetch, runFirstAmericanPrefetch, runScheduledDigest, type OutlookDigestEnv } from "./outlook-digest";

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
    if (controller.cron === "45 8,9 * * MON-FRI") {
      ctx.waitUntil((async () => {
      const prefetches = [
        { bank: "first_american", run: runFirstAmericanPrefetch(env, controller.scheduledTime) },
        { bank: "fifth_third", run: runFifthThirdPrefetch(env, controller.scheduledTime) },
      ];
      const results = await Promise.allSettled(prefetches.map((prefetch) => prefetch.run));
      for (const [index, result] of results.entries()) if (result.status === "rejected") {
        console.error(JSON.stringify({ event: `${prefetches[index].bank}_prefetch_failed`, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }));
      }
      })());
      return;
    }

    if (controller.cron === "0 9,10 * * MON-FRI") {
      ctx.waitUntil(runScheduledDigest(env, controller.scheduledTime));
      return;
    }

    ctx.waitUntil(runDailyWatchdog(env, controller.scheduledTime));
  },
};

export default worker;
