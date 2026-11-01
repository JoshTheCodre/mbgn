// Server-sent events. One in-process hub, so run a single server instance
// (or swap this for Redis pub/sub before scaling out).
export function createBus() {
  const clients = new Set();

  const write = (client, event, data) => {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    for (const client of clients) client.res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  return {
    connect(req, res, userId) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const client = { res, userId };
      clients.add(client);
      // Vercel ends functions after a time limit, so end first. The browser reconnects by itself.
      const limit = process.env.VERCEL ? setTimeout(() => res.end(), 50000) : null;
      req.on('close', () => {
        clearTimeout(limit);
        clients.delete(client);
      });
    },
    // Everyone on the site.
    publish(event, data) {
      for (const client of clients) write(client, event, data);
    },
    // Only the connections authenticated as this user.
    sendToUser(userId, event, data) {
      for (const client of clients) if (client.userId === userId) write(client, event, data);
    },
    disconnectUser(userId) {
      for (const client of clients) {
        if (client.userId === userId) {
          client.res.end();
          clients.delete(client);
        }
      }
    },
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.res.end();
      clients.clear();
    },
  };
}
