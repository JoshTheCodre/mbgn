// The wording of the WhatsApp messages to contestants, which admins can edit. Used by the server
// to write each message and by the admin page to preview it, so the two always agree.
//
// Admins write in Markdown, turned into WhatsApp's own formatting:
//   **bold** -> *bold*    __italic__ or _italic_ -> _italic_    ~~strike~~ -> ~strike~    # Heading -> *Heading*
// {name}-style fill-ins are replaced for each contestant.

export const MESSAGE_KINDS = {
  registered: { label: 'Application received', fills: ['name', 'group', 'dashboard'] },
  accepted: { label: 'Acceptance', fills: ['name', 'code', 'link', 'group', 'voting', 'dashboard'] },
  group_link: { label: 'Group link', fills: ['name', 'group_link'] },
  voting_open: { label: 'Voting open', fills: ['name', 'code', 'link', 'dashboard'] },
};

export const FILLS = {
  name: 'her stage name',
  code: 'her contestant code',
  link: 'her voting link',
  dashboard: 'her dashboard link',
  group: 'the line inviting her to her WhatsApp group (left out if she has none yet)',
  group_link: 'her WhatsApp group link',
  voting: 'when voting opens, or that it is open now',
};

export const DEFAULT_MESSAGES = {
  registered: `Hello {name}! 👋

Thank you for applying to Most Beautiful Girl Online Nigeria. Your application is in, and our team is reviewing it.

{group}

Once you're approved, we'll message you here with your contestant code and voting link.

Your dashboard: {dashboard}`,
  accepted: `Congratulations {name}! 🎉

You have been accepted into Most Beautiful Girl Online Nigeria.

Your contestant code: **{code}**
Your voting link: {link}

{group}

{voting}

Your dashboard: {dashboard}`,
  group_link: `Hello {name},

Your MBGN WhatsApp group is ready. Join it here for updates:
{group_link}`,
  voting_open: `Voting is now open, {name}! 🗳️

Send this to everyone you know, and post it on your status and socials:

"Please vote for me, {name}, in Most Beautiful Girl Online Nigeria! {link} (my code is {code})"

The more people share your link, the higher you climb.

Your dashboard: {dashboard}`,
};

export function toWhatsApp(markdown) {
  return markdown
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm, '**$1**')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/~~(.+?)~~/g, '~$1~');
}

// The finished message: fill-ins put in, Markdown turned into WhatsApp's, blank lines tidied
// (a fill-in left empty doesn't leave a gap).
export function renderMessage(template, values) {
  const filled = template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] ?? '' : match));
  return toWhatsApp(filled).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
