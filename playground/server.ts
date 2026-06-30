const DEFAULT_PORT = 8788;

const argPort = Number(Bun.argv[2]);
const envPort = Number(Bun.env.PLAYGROUND_PORT);
const port = Number.isInteger(argPort) && argPort > 0 ? argPort : Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_PORT;

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(Bun.file(new URL("./index.html", import.meta.url)), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`mirako-interactive-agent playground running at http://127.0.0.1:${server.port}`);
