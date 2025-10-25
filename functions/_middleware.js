export async function onRequest(context) {
  const { request } = context;
  const hostname = request.headers.get("host");
  
  // 只拦截 pages.dev，其他全部放行
  if (hostname.endsWith('.pages.dev')) {
    const url = new URL(request.url);
    return Response.redirect(`https://umi.li${url.pathname}${url.search}`, 301);
  }
  
  return await context.next();
}
