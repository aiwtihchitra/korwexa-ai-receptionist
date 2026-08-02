'use strict';

const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const { config } = require('../config');

function hasResendConfig() {
  return Boolean(config.email.resendApiKey);
}

async function sendViaResend({ to, subject, plainText }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.email.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.email.from,
      to,
      subject,
      text: plainText,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Resend email failed: ${response.status} ${bodyText}`);
  }

  return true;
}

function hasSmtpConfig() {
  return Boolean(config.email.smtp.host && config.email.smtp.user && config.email.smtp.pass);
}

async function sendViaSmtp({ to, subject, plainText }) {
  const transporter = nodemailer.createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.port === 465,
    auth: {
      user: config.email.smtp.user,
      pass: config.email.smtp.pass,
    },
  });

  const info = await transporter.sendMail({
    from: config.email.from,
    to,
    subject,
    text: plainText,
  });

  return info;
}

async function sendConfirmationEmail({ to, patientName, date, time, reason }) {
  const subject = `Appointment Confirmed - ${config.openai.businessName}`;
  const plainText = `Hello ${patientName},

Your appointment has been successfully confirmed.

Clinic:
${config.openai.businessName}

Date:
${date}

Time:
${time}

Reason:
${reason}

Thank you,

Sara
${config.openai.businessName}
`;

  if (hasResendConfig()) {
    await sendViaResend({ to, subject, plainText });
    return { provider: 'resend' };
  }

  if (hasSmtpConfig()) {
    const info = await sendViaSmtp({ to, subject, plainText });
    return { provider: 'smtp', info };
  }

  throw new Error('No email provider configured');
}

module.exports = { sendConfirmationEmail };
