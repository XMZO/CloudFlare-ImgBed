export async function onRequest(context) {
  const { request, env } = context;
  const hostname = request.headers.get("host") ?? "";

  // Patch `Headers.prototype.get` once so downstream code that prefers
  // `cf-connecting-ip` can still see the real client IP when the request is from
  // a trusted proxy (e.g. Hazuki).
  ensureCfConnectingIpOverride(env?.WORKER_SECRET_KEY, env?.TRUSTED_PROXY_IPS);
  
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

function ensureCfConnectingIpOverride(secretKey, trustedProxyIpsCsv) {
  const trustedProxyIps = parseTrustedProxyIps(trustedProxyIpsCsv);
  if (!secretKey && (!trustedProxyIps || trustedProxyIps.size === 0)) {
    return;
  }

  // Persist trust settings for the patched getter.
  globalThis.__hazukiWorkerSecretKey = secretKey || "";
  globalThis.__hazukiTrustedProxyIps = trustedProxyIps || new Set();

  if (globalThis.__hazukiPatchedHeadersGet) {
    return;
  }

  const originalGet = Headers.prototype.get;
  try {
    Headers.prototype.get = function patchedGet(name) {
      const lowerName = typeof name === "string" ? name.toLowerCase() : "";
      if (lowerName === "cf-connecting-ip") {
        let trusted = false;

        const secret = globalThis.__hazukiWorkerSecretKey;
        if (secret) {
          const workerKey = originalGet.call(this, "x-forwarded-by-worker");
          if (workerKey && workerKey === secret) {
            trusted = true;
          }
        }

        if (!trusted) {
          const trustedIps = globalThis.__hazukiTrustedProxyIps;
          const connectingIp = originalGet.call(this, "cf-connecting-ip");
          if (trustedIps && connectingIp && trustedIps.has(connectingIp)) {
            trusted = true;
          }
        }

        if (trusted) {
          const xRealIp = originalGet.call(this, "x-real-ip");
          if (xRealIp) {
            return xRealIp;
          }

          const xff = originalGet.call(this, "x-forwarded-for");
          const first = firstForwardedIp(xff);
          if (first) {
            return first;
          }
        }
      }

      return originalGet.call(this, name);
    };

    globalThis.__hazukiPatchedHeadersGet = true;
  } catch (_) {
    // If the runtime prevents patching built-in prototypes, just skip.
  }
}

function parseTrustedProxyIps(csv) {
  if (!csv) {
    return null;
  }

  const parts = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  return new Set(parts);
}
