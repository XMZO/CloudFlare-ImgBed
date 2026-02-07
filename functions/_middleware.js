export async function onRequest(context) {
  const { request, env } = context;
  const hostname = request.headers.get("host") ?? "";
  
  const SECRET_KEY = env.WORKER_SECRET_KEY;
  const workerKey = request.headers.get("X-Forwarded-By-Worker");
  const isFromWorker = SECRET_KEY && workerKey === SECRET_KEY;

  if (hostname.endsWith('.pages.dev') && !isFromWorker) {
    return new Response(null, {
      status: 444
    });
  }

  // If the request is from a trusted proxy (e.g. Hazuki), override Cloudflare's
  // cf-connecting-ip so the app can read the real client IP without code changes.
  if (isFromWorker) {
    const clientIp =
      request.headers.get("x-real-ip") ||
      firstForwardedIp(request.headers.get("x-forwarded-for"));

    if (clientIp) {
      const headers = new Headers(request.headers);
      headers.set("cf-connecting-ip", clientIp);
      const nextRequest = new Request(request, { headers });
      try {
        context.request = nextRequest;
      } catch (_) {
        // ignore
      }
      return await context.next(nextRequest);
    }
  }
  
  return await context.next();
}

function firstForwardedIp(xff) {
  if (!xff) {
    return null;
  }

  const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts[0] : null;
}
