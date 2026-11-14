// Sends through an Evolution API server (v2) that already has a connected instance. Evolution
// handles the WhatsApp connection itself: link the number in its manager, then point this at it.

export async function createEvolution({ url, apiKey, instance, log = console }) {
  const base = url.replace(/\/$/, '');
  const headers = { apikey: apiKey, 'Content-Type': 'application/json' };
  const path = (p) => `${base}${p}/${encodeURIComponent(instance)}`;
  let state = 'starting';
  let warned = false;

  async function refresh() {
    try {
      const res = await fetch(path('/instance/connectionState'), { headers, signal: AbortSignal.timeout(15000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.response?.message ?? data?.message ?? `answered ${res.status}`);
      const s = data?.instance?.state ?? data?.state;
      state = s === 'open' ? 'connected' : s === 'connecting' ? 'waiting_for_scan' : 'reconnecting';
      warned = false;
    } catch (err) {
      state = 'reconnecting';
      if (!warned) log.error(`Evolution API instance "${instance}" is not reachable: ${err.message}`);
      warned = true;
    }
  }

  await refresh();
  const timer = setInterval(refresh, 15000);

  return {
    name: 'evolution',
    get state() { return state; },
    account: null,
    async send(to, text) {
      const res = await fetch(path('/message/sendText'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ number: to, text }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) return { sent: true };
      const body = await res.text();
      // Evolution answers 400 with "exists": false for a number that is not on WhatsApp.
      const notOnWhatsApp = res.status === 400 && /"exists"\s*:\s*false/.test(body);
      return notOnWhatsApp
        ? { sent: false, final: true, error: 'This number is not on WhatsApp.' }
        : { sent: false, error: `Evolution API answered ${res.status}: ${body.slice(0, 200)}` };
    },
    async stop() { clearInterval(timer); },
  };
}
