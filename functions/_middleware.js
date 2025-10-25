export async function onRequest(context) {
  const { request } = context;
  const hostname = request.headers.get("host");
  const parts = hostname.split(".");
  const tld = parts.pop();
  const domain = parts.pop();

  if (domain === "pages" && tld === "dev") {
    return new Response("I'm a teapot", { status: 418 });
  }

  return await context.next();
}
