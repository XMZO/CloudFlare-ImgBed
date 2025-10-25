export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // 自定义域名
  const CUSTOM_DOMAIN = 'umi.li';
  
  // 检查是否是 pages.dev 域名
  if (url.hostname.endsWith('.pages.dev')) {
    // 构建新的 URL
    const redirectUrl = new URL(url);
    redirectUrl.hostname = CUSTOM_DOMAIN;
    
    // 使用 301 永久重定向
    return Response.redirect(redirectUrl.toString(), 301);
  }
  
  return await context.next();
}
