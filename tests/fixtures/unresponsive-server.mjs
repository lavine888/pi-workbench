// Transport fixture: ready, but intentionally never answers a request.
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "server_ready", params: { pid: process.pid } }) + "\n");
setInterval(() => {}, 1000);
