/* mailer.js — outbound email for account verification.
   Uses SMTP via nodemailer when SMTP_HOST is set; otherwise logs the
   verification link to the console so local dev works with zero setup. */
'use strict';

function baseUrl() {
  return (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

function verifyUrl(token) {
  return `${baseUrl()}/api/auth/verify?token=${encodeURIComponent(token)}`;
}

async function sendMail(to, subject, text, html) {
  if (!process.env.SMTP_HOST) {
    console.log(`[mail] SMTP not configured — would send to ${to}: ${subject}\n${text}`);
    return;
  }
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@localhost',
    to, subject, text, html,
  });
}

async function sendVerificationEmail(to, username, token) {
  const url = verifyUrl(token);
  const subject = 'Verify your Fire Kirin account';
  const text = `Hi ${username},\n\nConfirm your email to activate your account:\n${url}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`;
  const html = `<p>Hi ${username},</p><p>Confirm your email to activate your account:</p><p><a href="${url}">${url}</a></p><p>This link expires in 24 hours. If you didn't sign up, ignore this email.</p>`;
  await sendMail(to, subject, text, html);
}

module.exports = { sendVerificationEmail };
