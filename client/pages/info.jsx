import { Link } from 'react-router-dom';
import { getSite, money, num, useApp } from '../lib.jsx';

// Plain pages about how the contest works. Figures come from the live settings, so they stay right
// when an admin changes them.

function InfoPage({ eyebrow, title, intro, children }) {
  return (
    <div className="wrap page narrow-wide info-page">
      <header className="register-head">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {intro ? <p className="muted">{intro}</p> : null}
      </header>
      {children}
    </div>
  );
}

export function Rules() {
  const { competition } = useApp();
  const minFollowers = num(competition?.minFollowers ?? 500);
  const votePrice = money(competition?.votePrice ?? 200);
  const deals = [...(competition?.packages ?? [])].sort((a, b) => a.votes - b.votes);

  return (
    <InfoPage
      eyebrow={getSite().siteName}
      title="Contest rules"
      intro="By entering or voting, you agree to these rules. The organisers may update them, and the latest version is always on this page."
    >
      <section className="info-section">
        <h2>1. Entering the contest</h2>
        <ul>
          <li>Enter with your own details and a clear, recent photo of yourself.</li>
          <li>Choose one of your social media accounts, on Instagram, TikTok or Facebook. It needs at least <b>{minFollowers}</b> followers. We check it automatically when you apply, and the organisers may also check it by hand.</li>
          <li>Each person may apply once. Each WhatsApp number and each social media account can only be on one application.</li>
          <li>The organisers review every application and decide who is approved.</li>
        </ul>
      </section>

      <section className="info-section warn">
        <h2>2. Use only your own account</h2>
        <p>The social media account you enter must be yours. <b>If we find that you used an account that is not yours, you will be disqualified straight away</b>, at any stage of the contest, and your code will not be given to anyone else.</p>
      </section>

      <section className="info-section">
        <h2>3. Your contestant account</h2>
        <ul>
          <li>You log in with your phone or WhatsApp number and your 4-digit PIN. Keep your PIN to yourself.</li>
          <li>You can correct your details at any time. Once you are approved, a new stage name or photo only appears after the organisers approve it.</li>
          <li>Your contestant code is permanent and is never given to anyone else.</li>
        </ul>
      </section>

      <section className="info-section">
        <h2>4. Voting</h2>
        <ul>
          <li>Anyone can vote, as many times as they like. Each vote costs <b>{votePrice}</b>.</li>
          {deals.length ? (
            <li>
              Bulk deals: {deals.map((d) => `${num(d.votes)} votes for ${money(d.price)}`).join(', ')}.
              From each deal’s number of votes upwards, every vote costs that deal’s rate.
            </li>
          ) : null}
          <li>Votes count as soon as the payment is confirmed. Card payments are handled by Paystack. Votes bought in person from the organisers count the same way.</li>
          <li>Votes are final and are not refunded. If votes cannot be counted, for example because the contestant has left the contest or the results are final, the payment is refunded.</li>
          <li>The leaderboard ranks contestants by total votes. On a tie, whoever reached that total first stays ahead.</li>
        </ul>
      </section>

      <section className="info-section">
        <h2>5. Rounds and eliminations</h2>
        <ul>
          <li>Voting may run in rounds. Before each round, the organisers announce when it ends and what it takes to go through, such as staying in the top number of contestants or reaching a number of votes.</li>
          <li>When a round ends, contestants who miss its target are eliminated and can no longer receive votes. The organisers may put the few just below the cut on probation instead: they stay in, but are eliminated if they miss the next target.</li>
        </ul>
      </section>

      <section className="info-section">
        <h2>6. Fair play</h2>
        <ul>
          <li>Votes paid for with stolen cards, or gained by any other dishonest means, may be removed.</li>
          <li>The organisers may suspend or disqualify a contestant who breaks these rules or brings the contest into disrepute.</li>
          <li>The organisers’ decisions on approvals, votes, eliminations and results are final.</li>
        </ul>
      </section>

      <section className="info-section">
        <h2>7. Prizes</h2>
        <p>{getSite().prize ? `Over ${getSite().prize} in cash prizes is to be won.` : 'Cash prizes are to be won.'} The organisers announce how it is shared out and how winners are paid.</p>
      </section>

      <p className="muted form-foot">Questions? <Link to="/enquiry">Contact the organisers</Link>. See also our <Link to="/privacy">privacy notice</Link>.</p>
    </InfoPage>
  );
}

export function Privacy() {
  const { competition } = useApp();
  const email = competition?.contact?.email;
  return (
    <InfoPage eyebrow={getSite().siteName} title="Privacy notice" intro="What we collect, why, and who sees it.">
      <section className="info-section">
        <h2>Contestants</h2>
        <ul>
          <li><b>What we collect:</b> your full name, stage name, email, phone and WhatsApp numbers, {getSite().regionLabel.toLowerCase()}, town, biography, photo, the social media account you enter, and its follower count.</li>
          <li><b>What the public sees, once you are approved:</b> your stage name, photo, {getSite().regionLabel.toLowerCase()} and town, biography, social media link, code, votes and position.</li>
          <li><b>What stays private:</b> your full name, email, phone and WhatsApp numbers. Only the organisers see them, to run the contest and contact you.</li>
          <li>To read your follower count, we send your username or page link to a data service that reads public profiles. Nothing else about you is sent.</li>
        </ul>
      </section>
      <section className="info-section">
        <h2>Voters</h2>
        <ul>
          <li>We ask for your name or a nickname. It appears on your proof of vote, and the contestant you vote for sees it with your votes. The public never sees it.</li>
          <li>Payments are handled by Paystack. We never see or store your card details.</li>
          <li>If you ask for an emailed receipt, we use your email address only to send it.</li>
          <li>To spot fraud, we keep a scrambled form of your network address, which cannot be turned back into the address.</li>
        </ul>
      </section>
      <section className="info-section">
        <h2>Enquiries</h2>
        <p>When you send an enquiry, we keep your name, contact details and message so the organisers can reply.</p>
      </section>
      <p className="muted form-foot">
        To see, correct or remove your details, contestants can use their dashboard, and anyone can <Link to="/enquiry">contact the organisers</Link>
        {email ? <> or email <a href={`mailto:${email}`}>{email}</a></> : null}.
      </p>
    </InfoPage>
  );
}
