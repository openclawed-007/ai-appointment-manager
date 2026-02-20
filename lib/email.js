'use strict';

const nodemailer = require('nodemailer');

function escapeHtmlEmail(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function textToHtmlParagraphs(text = '') {
  return escapeHtmlEmail(text).replaceAll('\n', '<br/>');
}

/** Formats a 24-hour time string as 12-hour with AM/PM. */
function fmtTime(time24) {
  const [h, m] = String(time24 || '09:00').split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function buildBrandedEmailHtml({ businessName, title, subtitle, message, details = [] }) {
  const brand = escapeHtmlEmail(businessName || 'IntelliBook');
  const safeTitle = escapeHtmlEmail(title || 'Appointment Update');
  const safeSubtitle = subtitle ? `<p style="margin:6px 0 0;color:#64748b;font-size:14px;">${escapeHtmlEmail(subtitle)}</p>` : '';
  const safeMessage = textToHtmlParagraphs(message || '');
  const detailsHtml = details.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border-collapse:separate;border-spacing:0 8px;">
        ${details
      .map(
        (d) => `
              <tr>
                <td style="padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;width:140px;font-size:12px;font-weight:700;color:#334155;text-transform:uppercase;letter-spacing:.4px;">${escapeHtmlEmail(
          d.label
        )}</td>
                <td style="padding:8px 10px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;font-size:14px;color:#0f172a;">${escapeHtmlEmail(
          d.value
        )}</td>
              </tr>`
      )
      .join('')}
      </table>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#ffffff;">
                <div style="font-size:13px;opacity:.9;">${brand}</div>
                <div style="font-size:22px;font-weight:800;line-height:1.2;margin-top:4px;">${safeTitle}</div>
                ${safeSubtitle}
              </td>
            </tr>
            <tr>
              <td style="padding:20px;">
                <div style="font-size:14px;line-height:1.65;color:#0f172a;">${safeMessage}</div>
                ${detailsHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:14px 20px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;">
                Sent by ${brand}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildCancellationEmailHtml({ businessName, appointment, cancellationReason = '' }) {
  const brand = escapeHtmlEmail(businessName || 'IntelliBook');
  const clientName = escapeHtmlEmail(appointment?.clientName || 'there');
  const typeName = escapeHtmlEmail(appointment?.typeName || 'Appointment');
  const dateValue = escapeHtmlEmail(appointment?.date || '');
  const timeValue = escapeHtmlEmail(fmtTime(appointment?.time));
  const location = escapeHtmlEmail(appointment?.location || 'office');
  const reasonValue = String(cancellationReason || '').trim();
  const reasonBlock = reasonValue
    ? `
                <p style="margin:12px 0 0;font-size:14px;line-height:1.65;color:#7c2d12;">
                  <strong>Reason:</strong> ${escapeHtmlEmail(reasonValue)}
                </p>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fff7ed;font-family:Inter,Segoe UI,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #fed7aa;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:linear-gradient(135deg,#dc2626 0%,#f97316 100%);color:#ffffff;">
                <div style="font-size:13px;opacity:.95;">${brand}</div>
                <div style="font-size:22px;font-weight:800;line-height:1.2;margin-top:4px;">Appointment Cancelled</div>
                <p style="margin:6px 0 0;font-size:14px;opacity:.95;">${typeName}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px;">
                <p style="margin:0 0 10px;font-size:14px;line-height:1.65;color:#0f172a;">Hi ${clientName},</p>
                <p style="margin:0;font-size:14px;line-height:1.65;color:#7c2d12;background:#fff7ed;padding:12px;border-radius:10px;border:1px solid #fed7aa;">
                  Your appointment has been cancelled.
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0 8px;">
                  <tr>
                    <td style="padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;width:140px;font-size:12px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.4px;">Service</td>
                    <td style="padding:8px 10px;border:1px solid #fdba74;border-radius:10px;font-size:14px;color:#7c2d12;background:#fffbeb;">${typeName}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;width:140px;font-size:12px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.4px;">Date</td>
                    <td style="padding:8px 10px;border:1px solid #fdba74;border-radius:10px;font-size:14px;color:#7c2d12;background:#fffbeb;">${dateValue}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;width:140px;font-size:12px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.4px;">Time</td>
                    <td style="padding:8px 10px;border:1px solid #fdba74;border-radius:10px;font-size:14px;color:#7c2d12;background:#fffbeb;">${timeValue}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;width:140px;font-size:12px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.4px;">Location</td>
                    <td style="padding:8px 10px;border:1px solid #fdba74;border-radius:10px;font-size:14px;color:#7c2d12;background:#fffbeb;">${location}</td>
                  </tr>
                </table>
                ${reasonBlock}
              </td>
            </tr>
            <tr>
              <td style="padding:14px 20px;border-top:1px solid #fed7aa;font-size:12px;color:#9a3412;">
                Sent by ${brand}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Strip CR/LF from email subject to prevent header injection attacks. */
function sanitizeEmailSubject(s = '') {
  return String(s).replace(/[\r\n]+/g, ' ').trim();
}

async function sendEmail({ to, subject, html, text }) {
  if (!to) return { ok: false, reason: 'missing-to' };
  const safeSubject = sanitizeEmailSubject(subject);
  const fromEmail = process.env.FROM_EMAIL;

  if (process.env.RESEND_API_KEY && fromEmail) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: fromEmail, to: [to], subject: safeSubject, html, text })
      });

      if (!response.ok) {
        const body = await response.text();
        console.error('Resend failed:', body);
        return { ok: false, provider: 'resend', body };
      }
      return { ok: true, provider: 'resend' };
    } catch (error) {
      console.error('Resend error:', error);
      return { ok: false, provider: 'resend', error: String(error) };
    }
  }

  if (process.env.SMTP_HOST && fromEmail) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || 'false') === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
      });

      await transporter.sendMail({ from: fromEmail, to, subject: safeSubject, html, text });
      return { ok: true, provider: 'smtp' };
    } catch (error) {
      console.error('SMTP error:', error);
      return { ok: false, provider: 'smtp', error: String(error) };
    }
  }

  console.log('[EMAIL_SIMULATION]', { to, subject: safeSubject, preview: text?.slice(0, 120) });
  return { ok: true, provider: 'simulation' };
}

module.exports = {
  fmtTime,
  escapeHtmlEmail,
  buildBrandedEmailHtml,
  buildCancellationEmailHtml,
  sanitizeEmailSubject,
  sendEmail
};
