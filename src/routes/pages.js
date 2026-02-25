'use strict';

function registerPageRoutes(app, deps) {
  const {
    path,
    crypto,
    publicDir
  } = deps;

// ── Page routes ───────────────────────────────────────────────────────────────

app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/book', (_req, res) => res.sendFile(path.join(publicDir, 'booking.html')));
app.get('/reset-password', (_req, res) => res.sendFile(path.join(publicDir, 'reset-password.html')));

app.get('/verify-email', (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).send('Missing verification token.');
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'`
  );
  res.type('html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
  <body style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f8fafc;padding:24px;">
    <div style="max-width:560px;margin:40px auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px;">
      <h2 style="margin:0 0 10px;">Verifying your email...</h2>
      <p id="msg" style="color:#475569;">Please wait.</p>
      <a href="/" style="display:inline-block;margin-top:10px;">Go to dashboard</a>
    </div>
    <script nonce="${nonce}">
      fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest'},
        body: JSON.stringify({ token: ${JSON.stringify(token)} })
      })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'Verification failed');
        document.getElementById('msg').textContent = 'Email verified. Redirecting...';
        setTimeout(() => { window.location.href = '/'; }, 700);
      })
      .catch((e) => { document.getElementById('msg').textContent = e.message; });
    </script>
  </body>
</html>`);
});

}

module.exports = registerPageRoutes;
