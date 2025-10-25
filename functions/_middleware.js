export async function onRequest(context) {
  const { request, env } = context;
  const hostname = request.headers.get("host");
  
  // 从环境变量读取密钥
  const SECRET_KEY = env.WORKER_SECRET_KEY;
  const workerKey = request.headers.get("X-Forwarded-By-Worker");
  
  // 验证是否来自你的 Worker（密钥匹配）
  const isFromWorker = SECRET_KEY && workerKey === SECRET_KEY;
  
  // 只拦截直接访问 pages.dev 的请求
  if (hostname.endsWith('.pages.dev') && !isFromWorker) {
    return new Response('Forbidden', { 
      status: 403
    });
  }
  
  return await context.next();
}
