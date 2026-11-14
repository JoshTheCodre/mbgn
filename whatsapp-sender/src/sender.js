// The sender's loop, apart from WhatsApp itself: tell the site how the connection is, take the
// next message, send it, report back. The site decides what to send and to whom.

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export function createSiteClient({ siteUrl, token }) {
  async function call(path, body) {
    const res = await fetch(`${siteUrl.replace(/\/$/, '')}/api/whatsapp${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error ?? `The site answered ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  return {
    poll: (status) => call('/poll', status),
    report: (id, result) => call(`/messages/${id}/result`, result),
  };
}

// A message is sent at most once even if the site is briefly unreachable afterwards: the report
// is retried, since an unreported message goes back in the queue after 10 minutes.
async function report(site, id, result, signal) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await site.report(id, result);
    } catch (err) {
      if (attempt >= 5 || err.status === 404 || signal?.aborted) throw err;
      await sleep(attempt * 3000, signal);
    }
  }
}

function explain(err) {
  if (err.status === 401) return 'The site refused the sender token. WHATSAPP_SENDER_TOKEN must match the one set on the site.';
  if (err.status === 404) return 'The site has no WhatsApp sender. Set WHATSAPP_SENDER_TOKEN on the site (Vercel), and check SITE_URL.';
  return `Could not reach the site: ${err.message}`;
}

// One round: returns how many messages it handled.
export async function runOnce({ site, transport, log = console, signal }) {
  const { messages } = await site.poll({ state: transport.state, account: transport.account, transport: transport.name, limit: 1 });
  for (const message of messages) {
    const result = await transport.send(message.to, message.text)
      .catch((err) => ({ sent: false, error: err.message ?? String(err) }));
    await report(site, message.id, result, signal);
    if (result.sent) log.info(`Sent message ${message.id} to +${message.to}.`);
    else log.warn(`Message ${message.id} to +${message.to} not sent: ${result.error}`);
  }
  return messages.length;
}

export async function runSender({ site, transport, pollMs = 15000, gapMs = 6000, log = console, signal }) {
  let lastError = null;
  while (!signal?.aborted) {
    let handled = 0;
    try {
      handled = await runOnce({ site, transport, log, signal });
      if (lastError) log.info('Reaching the site again.');
      lastError = null;
    } catch (err) {
      const text = explain(err);
      // Said once, not every few seconds.
      if (text !== lastError) log.error(text);
      lastError = text;
    }
    // A steady pace between messages, and a slower check when there is nothing to send.
    await sleep(handled ? gapMs : pollMs, signal);
  }
}
