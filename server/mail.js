const nodemailer = require('nodemailer');
const { smtp, mailEnabled, APP_URL } = require('./config');

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      // 465 is implicit TLS; other ports upgrade with STARTTLS when offered
      secure: smtp.port === 465,
      // and on other ports the upgrade is mandatory: a stripped STARTTLS
      // would otherwise send the password and the link in clear text
      requireTLS: smtp.port !== 465,
      auth: { user: smtp.user, pass: smtp.pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return transport;
}

// Mail goes out only when SMTP is configured AND APP_URL is set, because the
// link in the mail must point at the real address, not a guessed one.
const canMail = () => mailEnabled && !!APP_URL;

const fmt = (ts) => new Date(ts).toUTCString();

// Returns 'sent', 'failed' or null (mail not set up / no address). Never
// throws: the link is already shown in the copy box either way.
async function sendLink({ to, name, kind, link, expiresAt }) {
  if (!canMail() || !to) return null;
  const subject = kind === 'invite' ? 'Your Kivo Office invite' : 'Reset your Kivo Office password';
  const lead = kind === 'invite'
    ? `You have been invited to Kivo Office. Open this link to choose your password and activate your account:`
    : `Someone asked for a new Kivo Office password for your account. Open this link to choose a new one. Your current password keeps working until you do:`;
  const text = [
    `Hi ${name},`,
    '',
    lead,
    '',
    link,
    '',
    `The link works once and expires ${fmt(expiresAt)}.`,
    'If you did not expect this email, you can ignore it.',
  ].join('\n');
  try {
    await getTransport().sendMail({ from: smtp.from, to, subject, text });
    return 'sent';
  } catch (e) {
    // e.message never contains the link; the recipient is fine to log
    console.error(`Could not email the ${kind} link to ${to}: ${e.message}`);
    return 'failed';
  }
}

module.exports = { sendLink, canMail };
