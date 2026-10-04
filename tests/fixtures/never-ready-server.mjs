// Startup fixture: alive, but intentionally never reports readiness.
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "booting", params: { pid: process.pid } }) + "\n");
setInterval(() => {}, 1000);
