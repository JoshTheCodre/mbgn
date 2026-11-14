// Prints each message instead of sending it, and tells the site it was sent. For trying the
// whole chain against a local copy of the site. Never point a dry run at the live site: its
// messages would be marked as sent without anyone receiving them.
export function createDryRun({ log = console } = {}) {
  return {
    name: 'dry-run',
    state: 'connected',
    account: null,
    async send(to, text) {
      log.info(`\n[dry run] To +${to}:\n${text}\n`);
      return { sent: true };
    },
    async stop() {},
  };
}
