// === 可拆分模块：静态资源判定 + 缓存服务 ===
const STATIC_EXTS = new Set([
    'png','jpg','jpeg','webp','avif','gif','svg','ico','bmp','heic','heif',
    'css','js','ttf','otf','woff','woff2','pdf','mp4','webm'
  ]);
  
  function isStaticPath(url) {
    const pathname = url.pathname;
    if (pathname.startsWith('/file/') || pathname.startsWith('/img/')) {
      return true;
    }
    const parts = pathname.split('.');
    if (parts.length < 2) return false; // 没有扩展名，不是静态资源
    const ext = parts.pop().toLowerCase();
    return STATIC_EXTS.has(ext);
  }
  
  function isBypassPath(url) {
    return url.pathname.startsWith('/api/')
        || url.pathname.includes('/accounts')
        || url.pathname.includes('/check-auth');
  }
  
  /**
   * 仅在静态资源时调用：清理会破坏缓存的请求头，启用边缘缓存（Cache API + cacheEverything）
   * 不修改非静态请求的行为
   */
  async function serveStaticWithCache(request, originUrl, env, ctx) {
    // 只处理 GET/HEAD
    if (!(request.method === 'GET' || request.method === 'HEAD')) return null;
  
    // 构造“干净请求头”
    const hdr = new Headers(request.headers);
    hdr.delete('cookie');
    hdr.delete('pragma');
    hdr.delete('cache-control');
    if (env.WORKER_SECRET_KEY) {
      hdr.set('X-Forwarded-By-Worker', env.WORKER_SECRET_KEY);
    }
  
    // cacheKey 可用“净化后的 URL”（按需可做 query 白名单）
    const cache = caches.default;
    const cacheKey = new Request(originUrl.toString(), { method: 'GET' });
  
    // 先查 Cache API
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  
    // 回源用 GET 填充缓存；但记录客户端是否是 HEAD
    const wantHead = (request.method === 'HEAD');
    const originReq = new Request(originUrl.toString(), {
      method: 'GET',
      headers: hdr,
      redirect: 'follow'
    });
  
    const originRes = await fetch(originReq, {
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { 
          '200-299': 31536000, // 2xx 边缘 1 年
          '403': 86400,        // 403 边缘 1 天
          '404': 300,          // 404 边缘 5 分钟
          '500-599': 0
        },
        cacheKey: originUrl.toString()
      }
    });
  
    // 3xx：不缓存 + 如果跳去 *.pages.dev，把 Location 修回自定义域
    if (originRes.status >= 300 && originRes.status < 400) {
      const oh = new Headers(originRes.headers);
      const loc = oh.get('Location');
      if (loc && /\.pages\.dev/i.test(loc)) {
        const reqOrigin = new URL(request.url).origin;
        oh.set('Location', loc.replace(/https?:\/\/[^/]*\.pages\.dev/gi, reqOrigin));
      }
      oh.set('Cache-Control', 'no-store');
      return new Response(null, {
        status: originRes.status,
        statusText: originRes.statusText,
        headers: oh
      });
    }
  
    // 按状态分级浏览器 TTL
    const status = originRes.status;
    const oh = new Headers(originRes.headers);
    oh.delete('Set-Cookie');
  
    if (status >= 200 && status < 300) {
      // 成功：浏览器 1 年 + immutable
      oh.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (status === 403) {
      // 403：浏览器 1 天
      oh.set('Cache-Control', 'public, max-age=86400');
    } else if (status === 404) {
      // 404：浏览器 5 分钟
      oh.set('Cache-Control', 'public, max-age=300');
    } else {
      // 其它状态：不缓存
      oh.set('Cache-Control', 'no-store');
    }
  
    // 写缓存用“有实体”的版本；客户端若是 HEAD，就回无 body
    const resForCache  = new Response(originRes.body, { status, statusText: originRes.statusText, headers: oh });
    const resForClient = wantHead
      ? new Response(null, { status, statusText: originRes.statusText, headers: oh })
      : resForCache;
  
    // Cache API 写入：仅 2xx/403/404（同步写，避免竞态）
    if ((status >= 200 && status < 300) || status === 403 || status === 404) {
      await cache.put(cacheKey, resForCache.clone());
    }
    return resForClient;
  }
  
  // === 你的原始逻辑 + 轻量接入点 ===
  export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const hostname = url.hostname;
  
      // 你的域名映射（保持不变）
      const hostMapping = { 
        'umi.li': 'cloudflare-imgbed-buu.pages.dev',
        
      };
      const targetHost = hostMapping[hostname] || 'xxxxxxxxxxxxxxxxx.hf.space';
  
      // 先准备 originUrl（保持与原来一致）
      const originUrl = new URL(url);
      originUrl.host = targetHost;
  
      // —— 仅在命中“静态资源”时尝试边缘缓存；否则不改变行为 ——
      if (isStaticPath(url) && !isBypassPath(url)) {
        const cachedRes = await serveStaticWithCache(request, originUrl, env, ctx);
        if (cachedRes) return cachedRes; // 命中或已写入缓存
        // 如果 serveStaticWithCache 返回 null，继续走原始逻辑
      }
  
      // 原样：创建新请求并转发（与你原代码一致）
      const newRequest = new Request(originUrl, request);
      if (env.WORKER_SECRET_KEY) {
        newRequest.headers.set('X-Forwarded-By-Worker', env.WORKER_SECRET_KEY);
      }
      return fetch(newRequest);
    }
  };
  
  
  /*
  export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      const hostname = url.hostname;
  
      const hostMapping = { 
        'umi.li': 'cloudflare-imgbed-buu.pages.dev'
      };
  
      const targetHost = hostMapping[hostname] || 'xxxxxxxxxxxxxxxxx.hf.space';
      url.host = targetHost;
  
      // 创建新请求
      const newRequest = new Request(url, request);
      
      // ⭐ 可选功能：如果配置了密钥，则添加验证头部
      if (env.WORKER_SECRET_KEY) {
        newRequest.headers.set('X-Forwarded-By-Worker', env.WORKER_SECRET_KEY);
      }
  
      return fetch(newRequest);
    }
  }
  */