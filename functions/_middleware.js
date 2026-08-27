// WebDAV PUT 会在 handler 内再次 POST 到基于 request.url 构造的 /upload；
// /dav 重写后，上传正文会经 ACTUAL_ORIGIN 反代多传输一遍，以兼容 pages.dev 的 444 防护。
const ACTUAL_ORIGIN_PATH_RE = /^(?:\/(?:upload|dav|random)(?:\/|$)|\/api\/public\/list(?:\/|$)|\/api\/manage\/(?:block|delete|move|rename|tags|white)(?:\/|$))/;

export async function onRequest(context) {
  const { request, env } = context;
  const hostname = request.headers.get("host") ?? "";
  const url = new URL(request.url);

  // Patch `Headers.prototype.get` once so downstream code that prefers
  // `cf-connecting-ip` can still see the real client IP when the request is from
  // a trusted proxy (e.g. Hazuki).
  ensureCfConnectingIpOverride(env?.WORKER_SECRET_KEY, env?.TRUSTED_PROXY_IPS);

  const SECRET_KEY = env.WORKER_SECRET_KEY;
  const workerKey = request.headers.get("X-Forwarded-By-Worker");
  const isFromWorker = SECRET_KEY && workerKey === SECRET_KEY;
  const rawGet = globalThis.__hazukiOriginalHeadersGet || Headers.prototype.get;
  const rawCfIp = safeHeaderGet(rawGet, request.headers, "cf-connecting-ip");
  const trustedProxyIps = globalThis.__hazukiTrustedProxyIps;
  const trustedByIp = !!(trustedProxyIps && rawCfIp && trustedProxyIps.has(rawCfIp));
  const isTrusted = !!isFromWorker || trustedByIp;
  let clientIp = null;

  if (isTrusted) {
    clientIp =
      safeHeaderGet(rawGet, request.headers, "x-hazuki-client-ip") ||
      safeHeaderGet(rawGet, request.headers, "x-real-ip") ||
      firstForwardedIp(safeHeaderGet(rawGet, request.headers, "x-forwarded-for"));

    if (clientIp) {
      patchHeadersGetInstance(request.headers, clientIp);
    }
  }

  if (hostname.endsWith('.pages.dev') && !isFromWorker) {
    return new Response(null, {
      status: 444
    });
  }

  if (
    isFromWorker &&
    url.hostname.endsWith(".pages.dev") &&
    ACTUAL_ORIGIN_PATH_RE.test(url.pathname)
  ) {
    const rewrittenRequest = createActualOriginRequest(request, url, env?.ACTUAL_ORIGIN);
    if (rewrittenRequest) {
      if (clientIp) {
        patchHeadersGetInstance(rewrittenRequest.headers, clientIp);
      }
      try {
        context.request = rewrittenRequest;
      } catch (_) {}
      return await context.next(rewrittenRequest);
    }
  }

  return await context.next();
}

function createActualOriginRequest(request, requestUrl, configuredOrigin) {
  if (typeof configuredOrigin !== "string" || configuredOrigin.trim() === "") {
    return null;
  }

  try {
    const actualOrigin = new URL(configuredOrigin.trim());
    if (
      (actualOrigin.protocol !== "https:" && actualOrigin.protocol !== "http:") ||
      !actualOrigin.hostname ||
      actualOrigin.username ||
      actualOrigin.password ||
      requestUrl.origin === actualOrigin.origin
    ) {
      return null;
    }

    requestUrl.protocol = actualOrigin.protocol;
    requestUrl.host = actualOrigin.host;
    const rewrittenRequest = new Request(requestUrl.toString(), request);
    try {
      rewrittenRequest.headers.set("host", actualOrigin.host);
    } catch (_) {}
    if (request.cf !== undefined && rewrittenRequest.cf === undefined) {
      try {
        Object.defineProperty(rewrittenRequest, "cf", {
          value: request.cf,
          enumerable: true,
          configurable: true,
        });
      } catch (_) {}
    }
    return rewrittenRequest;
  } catch (_) {
    return null;
  }
}

function firstForwardedIp(xff) {
  if (!xff) {
    return null;
  }

  const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts[0] : null;
}

function safeHeaderGet(getFn, headers, name) {
  if (!getFn || !headers) {
    return null;
  }
  try {
    return getFn.call(headers, name);
  } catch (_) {
    return null;
  }
}

function patchHeadersGetInstance(headers, clientIp) {
  if (!headers || !clientIp) {
    return false;
  }

  const originalGet = headers.get?.bind(headers);
  if (!originalGet) {
    return false;
  }

  const patchedGet = (name) => {
    const lowerName = typeof name === "string" ? name.toLowerCase() : "";
    if (lowerName === "cf-connecting-ip") {
      return clientIp;
    }
    return originalGet(name);
  };

  try {
    headers.get = patchedGet;
    return true;
  } catch (_) {
    // ignore
  }

  try {
    Object.defineProperty(headers, "get", {
      value: patchedGet,
      writable: true,
      configurable: true,
    });
    return true;
  } catch (_) {
    // ignore
  }

  return false;
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
  if (!globalThis.__hazukiOriginalHeadersGet) {
    globalThis.__hazukiOriginalHeadersGet = originalGet;
  }
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
          const hzClientIp = originalGet.call(this, "x-hazuki-client-ip");
          if (hzClientIp) {
            return hzClientIp;
          }

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
    globalThis.__hazukiPatchedHeadersGetError = "failed to patch Headers.prototype.get";
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
