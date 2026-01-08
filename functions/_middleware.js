export async function onRequest(context) {
  const { request, env } = context;
  const hostname = request.headers.get("host");
  
  if (hostname.endsWith('.pages.dev')) {
    const SECRET_KEY = env.WORKER_SECRET_KEY;
    const workerKey = request.headers.get("X-Forwarded-By-Worker");
    const isFromWorker = SECRET_KEY && workerKey === SECRET_KEY;
    
    if (!isFromWorker) {
      return new Response(null, { 
        status: 444
      });
    }
  }
  
  return await context.next();
}
