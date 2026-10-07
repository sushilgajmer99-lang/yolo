'use strict';
// Sends the sign-in link. Configure SMTP_URL (e.g. smtps://user:pass@smtp.gmail.com:465)
// and MAIL_FROM. Without SMTP the link is printed to the server console (dev only).
const nodemailer = require('nodemailer');

const configured = () => !!process.env.SMTP_URL;

async function sendLoginLink(to, link) {
  if (!configured()) {
    console.log(`\n[dev] Sign-in link for ${to}:\n${link}\n`);
    return false;
  }
  const transport = nodemailer.createTransport(process.env.SMTP_URL);
  await transport.sendMail({
    from: process.env.MAIL_FROM || 'Dept Tracker <no-reply@localhost>',
    to,
    subject: 'Your sign-in link for Dept Tracker',
    text: `Click to sign in (valid 15 minutes, one use):\n\n${link}\n\nIf you did not request this, ignore this email.`,
    html: `<p>Click to sign in (valid 15 minutes, one use):</p><p><a href="${link}">Sign in to Dept Tracker</a></p><p>If you did not request this, ignore this email.</p>`,
  });
  return true;
}

module.exports = { sendLoginLink, configured };
