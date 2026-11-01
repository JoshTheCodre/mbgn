import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, dateTime, naira, num, useApp, useFetch, useLive } from '../lib.jsx';
import { Dialog, ErrorNote, Field, Loading, Portrait } from '../ui.jsx';

const TABS = [
  ['overview', 'Overview'],
  ['contestants', 'Contestants'],
  ['money', 'Payments & votes'],
  ['review', 'Review'],
  ['competition', 'Competition'],
  ['messages', 'Messages'],
  ['reports', 'Reports'],
];

export function Admin() {
  const [tab, setTab] = useState('overview');
  const { data: overview, reload } = useFetch('/admin/overview');
  useLive('leaderboard', reload);
  useLive('admin', reload);
  return (
    <div className="wrap page admin">
      <div className="page-head"><h1>Control panel</h1></div>
      <div className="tabs admin-tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); reload(); }}>
            {label}
            {key === 'contestants' && overview?.pending ? <span className="badge">{overview.pending}</span> : null}
            {key === 'review' && overview?.openFlags ? <span className="badge">{overview.openFlags}</span> : null}
          </button>
        ))}
      </div>
      {tab === 'overview' ? <Overview data={overview} go={setTab} /> : null}
      {tab === 'contestants' ? <ContestantsTab onChange={reload} /> : null}
      {tab === 'money' ? <MoneyTab onChange={reload} /> : null}
      {tab === 'review' ? <ReviewTab onChange={reload} /> : null}
      {tab === 'competition' ? <CompetitionTab onChange={reload} /> : null}
      {tab === 'messages' ? <MessagesTab /> : null}
      {tab === 'reports' ? <ReportsTab /> : null}
    </div>
  );
}

function Overview({ data, go }) {
  if (!data) return <Loading />;
  return (
    <>
      <dl className="tiles tiles-3">
        <div><dt>Revenue</dt><dd>{naira(data.revenue)}</dd><small>{naira(data.revenue24h)} in 24 hrs</small></div>
        <div><dt>Valid votes</dt><dd>{num(data.totalVotes)}</dd><small>{num(data.votes24h)} in 24 hrs</small></div>
        <div><dt>Active contestants</dt><dd>{num(data.contestants)}</dd><small>{num(data.pending)} waiting for review</small></div>
      </dl>
      <section className="panel">
        <h2>Needs your attention</h2>
        <ul className="todo">
          <li><button type="button" className="text-link as-button" onClick={() => go('contestants')}>{num(data.pending)} applications waiting for review</button></li>
          <li><button type="button" className="text-link as-button" onClick={() => go('review')}>{num(data.openFlags)} open fraud flags</button></li>
          <li><button type="button" className="text-link as-button" onClick={() => go('money')}>{num(data.paymentsInReview)} payments in review, {num(data.votesHeld)} held for refund</button></li>
          <li>Voting status: <b>{data.voting.status}</b>. <button type="button" className="text-link as-button" onClick={() => go('competition')}>Change</button></li>
        </ul>
      </section>
    </>
  );
}

function ActionDialog({ action, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(''); setError(null); }, [action]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action.run({ reason });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(action)} onClose={onClose} title={action?.title ?? ''}>
      <form className="stack" onSubmit={submit}>
        {action?.description ? <p>{action.description}</p> : null}
        {action?.needsReason !== false ? (
          <Field label={action?.reasonLabel ?? 'Reason'}>
            <textarea rows={3} required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        ) : null}
        <ErrorNote error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={busy}>{busy ? 'Working…' : action?.confirm ?? 'Confirm'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function ContestantsTab({ onChange }) {
  const [status, setStatus] = useState('pending');
  const [q, setQ] = useState('');
  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (q) query.set('q', q);
  const { data, error, reload } = useFetch(`/admin/contestants?${query}`);
  const [action, setAction] = useState(null);
  const [opened, setOpened] = useState(null);
  const [actionError, setActionError] = useState(null);
  const refresh = () => { reload(); onChange(); };

  async function approve(c) {
    setActionError(null);
    try {
      await api(`/admin/contestants/${c.id}/approve`, { method: 'POST' });
      refresh();
    } catch (err) {
      setActionError(err);
    }
  }
  async function resend(c) {
    setActionError(null);
    try {
      await api(`/admin/contestants/${c.id}/resend-code`, { method: 'POST' });
    } catch (err) {
      setActionError(err);
    }
  }
  async function setCategory(c, category) {
    await api(`/admin/contestants/${c.id}`, { method: 'PATCH', body: { category } }).catch(setActionError);
    reload();
  }
  const statusAction = (c, verb, title, description) => setAction({
    title,
    description,
    confirm: title,
    needsReason: verb !== 'reinstate',
    reasonLabel: 'Reason (the contestant will see this)',
    run: ({ reason }) => api(`/admin/contestants/${c.id}/${verb}`, { body: { reason } }),
  });

  return (
    <>
      <div className="filters">
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {['pending', 'approved', 'rejected', 'suspended', 'disqualified'].map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Search name, code or email"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
      </div>
      <ErrorNote error={error ?? actionError} />
      {!data ? <Loading /> : data.length === 0 ? <p className="muted empty">Nothing here{status === 'pending' ? ': the review queue is clear' : ''}.</p> : (
        <ul className="admin-list">
          {data.map((c) => (
            <li key={c.id} className="admin-card">
              <div className="admin-card-head">
                <Portrait name={c.stageName} photoUrl={c.photoUrl} code={c.code ?? c.stageName} className="admin-photo" />
                <div className="admin-card-who">
                  <strong>{c.stageName}</strong> <em className={`tag tag-${c.status}`}>{c.status}</em>
                  <small>{c.code ?? 'No code yet'}{c.position ? ` · position ${c.position} · ${num(c.totalVotes)} votes` : ''}</small>
                  <small>{c.location}, {c.state} · applied {dateTime(c.createdAt)}</small>
                </div>
                <div className="admin-actions">
                  {c.status === 'pending' || c.status === 'rejected' ? <button type="button" className="btn btn-primary btn-small" onClick={() => approve(c)}>Approve</button> : null}
                  {c.status === 'pending' ? <button type="button" className="btn btn-ghost btn-small" onClick={() => statusAction(c, 'reject', 'Reject application')}>Reject</button> : null}
                  {c.status === 'approved' ? <button type="button" className="btn btn-ghost btn-small" onClick={() => statusAction(c, 'suspend', 'Suspend contestant', 'The profile disappears from the public site and cannot receive votes.')}>Suspend</button> : null}
                  {c.status === 'approved' || c.status === 'suspended' ? <button type="button" className="btn btn-ghost btn-small" onClick={() => statusAction(c, 'disqualify', 'Disqualify contestant', 'Removed from the leaderboard. The code is never reassigned.')}>Disqualify</button> : null}
                  {c.status === 'suspended' || c.status === 'disqualified' ? <button type="button" className="btn btn-ghost btn-small" onClick={() => statusAction(c, 'reinstate', 'Reinstate contestant', 'Returns to the leaderboard with the existing votes and code.')}>Reinstate</button> : null}
                  <button type="button" className="btn btn-ghost btn-small" aria-expanded={opened === c.id} onClick={() => setOpened(opened === c.id ? null : c.id)}>{opened === c.id ? 'Hide' : 'Details'}</button>
                </div>
              </div>
              {opened === c.id ? (
                <div className="admin-details">
                  <dl>
                    <div><dt>Full name</dt><dd>{c.fullName}</dd></div>
                    <div><dt>Email</dt><dd>{c.email}</dd></div>
                    <div><dt>Phone</dt><dd>{c.phone}</dd></div>
                    <div><dt>WhatsApp</dt><dd>{c.whatsapp}</dd></div>
                    <div><dt>Socials</dt><dd className="social-links">
                      {c.tiktok ? <a href={c.tiktok} target="_blank" rel="noreferrer noopener">TikTok</a> : null}
                      {c.instagram ? <a href={c.instagram} target="_blank" rel="noreferrer noopener">Instagram</a> : null}
                      {c.facebook ? <a href={c.facebook} target="_blank" rel="noreferrer noopener">Facebook</a> : null}
                      {!c.tiktok && !c.instagram && !c.facebook ? 'None given' : null}
                    </dd></div>
                    {c.statusReason ? <div><dt>Reason</dt><dd>{c.statusReason}</dd></div> : null}
                  </dl>
                  <p className="admin-bio">{c.bio}</p>
                  <div className="inline-form">
                    <Field label="Category / group"><input defaultValue={c.category ?? ''} onBlur={(e) => { if (e.target.value !== (c.category ?? '')) setCategory(c, e.target.value); }} /></Field>
                    {c.status === 'approved' ? <button type="button" className="btn btn-ghost" onClick={() => resend(c)}>Resend code &amp; link</button> : null}
                    {c.status === 'approved' ? <Link className="btn btn-ghost" to={`/c/${c.code}`}>Public profile</Link> : null}
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ActionDialog action={action} onClose={() => setAction(null)} onDone={() => { setAction(null); refresh(); }} />
    </>
  );
}

function MoneyTab({ onChange }) {
  const [view, setView] = useState('payments');
  const payments = useFetch(view === 'payments' ? '/admin/payments' : null);
  const votes = useFetch(view === 'votes' ? '/admin/votes' : null);
  const [action, setAction] = useState(null);
  return (
    <>
      <div className="qty-chips">
        <button type="button" className={`chip ${view === 'payments' ? 'active' : ''}`} onClick={() => setView('payments')}>Payments</button>
        <button type="button" className={`chip ${view === 'votes' ? 'active' : ''}`} onClick={() => setView('votes')}>Votes</button>
      </div>
      {view === 'payments' ? (
        !payments.data ? <Loading /> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Date</th><th>Reference</th><th>Receipt email</th><th className="num">Votes</th><th className="num">Amount</th><th>Status</th></tr></thead>
              <tbody>
                {payments.data.map((p) => (
                  <tr key={p.reference}>
                    <td>{dateTime(p.createdAt)}</td>
                    <td>{p.status === 'paid' ? <Link to={`/receipt/payment/${p.reference}`}>{p.reference}</Link> : p.reference}</td>
                    <td>{p.email ?? '—'}</td>
                    <td className="num">{num(p.votes)}</td>
                    <td className="num">{naira(p.amount)}</td>
                    <td><em className={`tag tag-${p.status}`}>{p.status}</em>{p.votesStatus === 'held' ? <em className="tag tag-review">refund due</em> : null}</td>
                  </tr>
                ))}
                {payments.data.length === 0 ? <tr><td colSpan="6" className="muted">No payments yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        )
      ) : (
        !votes.data ? <Loading /> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Date</th><th>Receipt</th><th>Contestant</th><th className="num">Votes</th><th>Receipt email</th><th>Status</th><th><span className="visually-hidden">Action</span></th></tr></thead>
              <tbody>
                {votes.data.map((v) => (
                  <tr key={v.id}>
                    <td>{dateTime(v.createdAt)}</td>
                    <td><Link to={`/receipt/vote/${v.receiptNo}`}>{v.receiptNo}</Link></td>
                    <td>{v.name} ({v.code})</td>
                    <td className="num">{num(v.quantity)}</td>
                    <td>{v.email ?? '—'}</td>
                    <td><em className={`tag tag-${v.status}`}>{v.status}</em></td>
                    <td>
                      {v.status === 'valid' ? (
                        <button
                          type="button"
                          className="text-link as-button"
                          onClick={() => setAction({
                            title: 'Void this vote',
                            description: `Removes ${v.quantity} votes from ${v.name} and recalculates the leaderboard. Any refund is done separately in Paystack.`,
                            confirm: 'Void vote',
                            run: ({ reason }) => api(`/admin/votes/${v.id}/void`, { body: { reason } }),
                          })}
                        >Void</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {votes.data.length === 0 ? <tr><td colSpan="7" className="muted">No votes yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        )
      )}
      <ActionDialog action={action} onClose={() => setAction(null)} onDone={() => { setAction(null); votes.reload(); onChange(); }} />
    </>
  );
}

function ReviewTab({ onChange }) {
  const [status, setStatus] = useState('open');
  const { data, reload, error } = useFetch(`/admin/flags?status=${status}`);
  const close = async (id, outcome) => { await api(`/admin/flags/${id}/${outcome}`, { method: 'POST' }); reload(); onChange(); };
  return (
    <>
      <p className="muted">Suspicious patterns are flagged here automatically. Nothing is blocked until you decide. To remove votes, void them under Payments &amp; votes.</p>
      <div className="qty-chips">
        {['open', 'resolved', 'dismissed'].map((s) => <button key={s} type="button" className={`chip ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>{s}</button>)}
      </div>
      <ErrorNote error={error} />
      {!data ? <Loading /> : data.length === 0 ? <p className="muted empty">Nothing to review.</p> : (
        <ul className="admin-list">
          {data.map((f) => (
            <li key={f.id} className="admin-card flag">
              <div>
                <strong>{f.kind.replace(/_/g, ' ')}</strong> <em className={`tag tag-sev-${f.severity}`}>{f.severity}</em>
                <p>{f.details}</p>
                <small className="muted">{dateTime(f.createdAt)}{f.code ? ` · ${f.code}` : ''}</small>
              </div>
              <div className="admin-actions">
                {f.status === 'open' ? (
                  <>
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => close(f.id, 'dismissed')}>Dismiss</button>
                    <button type="button" className="btn btn-primary btn-small" onClick={() => close(f.id, 'resolved')}>Mark resolved</button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function PackageRow({ pack, reload, setError }) {
  const save = async (changes) => {
    try {
      await api(`/admin/packages/${pack.id}`, { method: 'PATCH', body: changes });
      reload();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <tr>
      <td><input aria-label="Votes" type="number" min="1" defaultValue={pack.votes} onBlur={(e) => { const v = Number(e.target.value); if (v !== pack.votes) save({ votes: v }); }} /></td>
      <td><input aria-label="Price in naira" type="number" min="1" defaultValue={pack.price} onBlur={(e) => { const v = Number(e.target.value); if (v !== pack.price) save({ price: v }); }} /></td>
      <td><button type="button" className="text-link as-button" onClick={() => save({ active: !pack.active })}>{pack.active ? 'Hide' : 'Show'}</button> <small className="muted">{pack.active ? 'on sale' : 'hidden'}</small></td>
    </tr>
  );
}

function CompetitionTab({ onChange }) {
  const { refreshCompetition } = useApp();
  const { data, reload } = useFetch('/admin/settings');
  const results = useFetch('/results');
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [action, setAction] = useState(null);

  async function saveSettings(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    setSaved(false);
    try {
      await api('/admin/settings', {
        method: 'PUT',
        body: {
          name: f.get('name'),
          votePrice: Number(f.get('votePrice')),
          largeVoteThreshold: Number(f.get('largeVoteThreshold')),
          startsAt: f.get('startsAt') ? new Date(f.get('startsAt')).toISOString() : '',
          endsAt: f.get('endsAt') ? new Date(f.get('endsAt')).toISOString() : '',
        },
      });
      setSaved(true);
      reload();
      refreshCompetition();
    } catch (err) {
      setError(err);
    }
  }

  async function setVoting(status) {
    setError(null);
    try {
      await api(`/admin/voting/${status}`, { method: 'POST' });
      reload();
      onChange();
      refreshCompetition();
    } catch (err) {
      setError(err);
    }
  }

  async function addPackage(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api('/admin/packages', { body: { votes: Number(f.get('votes')), price: Number(f.get('price')) } });
      form.reset();
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function addHistory(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api('/admin/results/history', { body: { competition: f.get('competition'), winner: f.get('winner'), date: f.get('date') } });
      form.reset();
      results.reload();
    } catch (err) {
      setError(err);
    }
  }

  if (!data) return <Loading />;
  const closed = data.votingStatus === 'closed';

  return (
    <div className="admin-columns">
      <ErrorNote error={error} />
      <section className="panel">
        <h2>Voting</h2>
        <p>Voting is currently <b>{data.votingStatus}</b>.</p>
        <div className="admin-actions">
          <button type="button" className="btn btn-primary btn-small" disabled={data.votingStatus === 'open'} onClick={() => setVoting('open')}>Open</button>
          <button type="button" className="btn btn-ghost btn-small" disabled={data.votingStatus === 'paused'} onClick={() => setVoting('paused')}>Pause</button>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={closed}
            onClick={() => setAction({
              title: 'Close voting',
              description: 'Supporters will no longer be able to vote.',
              confirm: 'Close voting',
              needsReason: false,
              run: () => api('/admin/voting/closed', { method: 'POST' }),
            })}
          >Close</button>
        </div>
        <h3>Final results</h3>
        {data.resultsPublishedAt ? <p className="muted">Published {dateTime(data.resultsPublishedAt)}. Reopening voting starts a new results round.</p> : (
          <>
            <p className="muted">{closed ? 'Publishing freezes the current standings on the Winners page.' : 'Close voting first.'}</p>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={!closed}
              onClick={() => setAction({
                title: 'Publish final results',
                description: 'The current standings go public on the Winners page and everyone is told who won.',
                confirm: 'Publish results',
                needsReason: false,
                run: () => api('/admin/results/publish', { method: 'POST' }),
              })}
            >Publish final results</button>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Competition details</h2>
        <form className="stack" onSubmit={saveSettings}>
          <Field label="Competition name"><input name="name" defaultValue={data.name} required /></Field>
          <div className="form-grid">
            <Field label="Voting opens" hint="Blank means open now."><input name="startsAt" type="datetime-local" defaultValue={toLocalInput(data.startsAt)} /></Field>
            <Field label="Voting closes" hint="Drives the countdown."><input name="endsAt" type="datetime-local" defaultValue={toLocalInput(data.endsAt)} /></Field>
            <Field label="Price per vote (₦)" hint="Used for custom amounts."><input name="votePrice" type="number" min="1" defaultValue={data.votePrice} required /></Field>
            <Field label="Flag single votes of at least" hint="0 turns this off."><input name="largeVoteThreshold" type="number" min="0" defaultValue={data.largeVoteThreshold} required /></Field>
          </div>
          {saved ? <p className="note note-good">Saved.</p> : null}
          <button className="btn btn-primary">Save details</button>
        </form>
      </section>

      <section className="panel">
        <h2>Voting packages</h2>
        <div className="table-wrap">
          <table className="data-table packages-table">
            <thead><tr><th>Votes</th><th>Price (₦)</th><th>On sale</th></tr></thead>
            <tbody>{data.packages.map((p) => <PackageRow key={`${p.id}-${p.votes}-${p.price}`} pack={p} reload={reload} setError={setError} />)}</tbody>
          </table>
        </div>
        <form className="inline-form" onSubmit={addPackage}>
          <Field label="Votes"><input name="votes" type="number" min="1" required /></Field>
          <Field label="Price (₦)"><input name="price" type="number" min="1" required /></Field>
          <button className="btn btn-ghost">Add package</button>
        </form>
      </section>

      <section className="panel">
        <h2>Competition history</h2>
        <ul className="history">
          {(results.data ?? []).map((r) => (
            <li key={r.id}>
              <span><b>{r.competition}</b><small>Winner: {r.standings[0]?.name} · {dateTime(r.publishedAt)}</small></span>
              <button
                type="button"
                className="text-link as-button"
                onClick={() => setAction({
                  title: 'Remove this record',
                  description: `Removes "${r.competition}" from the public Winners page.`,
                  confirm: 'Remove record',
                  needsReason: false,
                  run: () => api(`/admin/results/${r.id}`, { method: 'DELETE' }),
                })}
              >Remove</button>
            </li>
          ))}
        </ul>
        <form className="inline-form" onSubmit={addHistory}>
          <Field label="Past edition"><input name="competition" required placeholder="MBGN 2025" /></Field>
          <Field label="Winner"><input name="winner" required /></Field>
          <Field label="Date"><input name="date" type="date" required /></Field>
          <button className="btn btn-ghost">Add record</button>
        </form>
      </section>

      <ActionDialog
        action={action}
        onClose={() => setAction(null)}
        onDone={() => { setAction(null); reload(); results.reload(); onChange(); refreshCompetition(); }}
      />
    </div>
  );
}

function MessagesTab() {
  const announcements = useFetch('/admin/announcements');
  const activity = useFetch('/admin/activity');
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);

  async function announce(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(null);
    setSent(null);
    try {
      const { recipients } = await api('/admin/announcements', { body: { title: f.get('title'), body: f.get('body'), public: f.get('public') === 'on' } });
      setSent(`Sent to ${num(recipients)} contestants.`);
      form.reset();
      announcements.reload();
      activity.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function postPublic(e) {
    e.preventDefault();
    const form = e.currentTarget;
    setError(null);
    try {
      await api('/admin/activity', { body: { message: new FormData(form).get('message') } });
      form.reset();
      activity.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function toggle(item) {
    await api(`/admin/activity/${item.id}/visibility`, { body: { hidden: !item.hidden } }).catch(setError);
    activity.reload();
  }

  return (
    <div className="admin-columns">
      <ErrorNote error={error} />
      <section className="panel">
        <h2>Announcement to contestants</h2>
        <form className="stack" onSubmit={announce}>
          <Field label="Title"><input name="title" required /></Field>
          <Field label="Message"><textarea name="body" rows={4} required /></Field>
          <label className="check-line"><input type="checkbox" name="public" /> Also show it in the public activity feed</label>
          {sent ? <p className="note note-good">{sent}</p> : null}
          <button className="btn btn-primary">Send to all approved contestants</button>
        </form>
        <h3>Sent</h3>
        {!announcements.data?.length ? <p className="muted">Nothing sent yet.</p> : (
          <ul className="history">
            {announcements.data.map((a) => <li key={a.id}><span><b>{a.title}</b><small>{a.body}</small></span><small>{dateTime(a.created_at)}</small></li>)}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>Public notifications</h2>
        <form className="inline-form" onSubmit={postPublic}>
          <Field label="Post to the public feed"><input name="message" required maxLength={200} /></Field>
          <button className="btn btn-ghost">Post</button>
        </form>
        {!activity.data ? <Loading /> : (
          <ul className="history">
            {activity.data.map((a) => (
              <li key={a.id} className={a.hidden ? 'is-hidden' : ''}>
                <span>{a.message}<small>{dateTime(a.createdAt)}{a.hidden ? ' · hidden' : ''}</small></span>
                <button type="button" className="text-link as-button" onClick={() => toggle(a)}>{a.hidden ? 'Show' : 'Hide'}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ReportsTab() {
  const outbox = useFetch('/admin/outbox');
  const audit = useFetch('/admin/audit');
  return (
    <div className="admin-columns">
      <section className="panel">
        <h2>Export reports</h2>
        <div className="share-row">
          <a className="btn btn-ghost" href="/api/admin/export/contestants.csv">Contestants (CSV)</a>
          <a className="btn btn-ghost" href="/api/admin/export/votes.csv">Votes (CSV)</a>
          <a className="btn btn-ghost" href="/api/admin/export/payments.csv">Payments (CSV)</a>
        </div>
      </section>
      <section className="panel">
        <h2>Email log</h2>
        {!outbox.data?.length ? <p className="muted">No emails yet.</p> : (
          <ul className="history">
            {outbox.data.map((m) => <li key={m.id}><span><b>{m.subject}</b><small>{m.to_addr} · {dateTime(m.created_at)}</small></span><em className="tag">{m.status}</em></li>)}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>Admin activity</h2>
        {!audit.data?.length ? <p className="muted">No admin actions yet.</p> : (
          <ul className="history">
            {audit.data.map((a, i) => <li key={i}><span><b>{a.action}</b><small>{a.details}</small></span><small>{dateTime(a.created_at)}</small></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
