# IntelliSchedule

Sleek appointment management software with:
- Flexible appointment types for **any business**
- Owner dashboard + public booking page
- Automatic confirmation/owner notification emails
- AI-style insights based on real booking data
- Very simple setup (SQLite, no external DB required)

---

## What’s now implemented

### Frontend
- Keeps your calm/sleek style and animations
- Dashboard (`/`) with:
  - Stats cards (today/week/pending/optimized)
  - Today timeline
  - Appointment type manager view
  - AI insights panel
  - New appointment modal wired to backend
- Public booking page (`/book`) for customers

### Backend
- Express API + SQLite (`better-sqlite3`) for reliability and no-fuss setup
- Endpoints:
  - `GET /api/dashboard`
  - `GET /api/appointments`
  - `POST /api/appointments`
  - `PATCH /api/appointments/:id/status`
  - `GET /api/types`
  - `POST /api/types`
  - `PUT /api/types/:id`
  - `DELETE /api/types/:id`
  - `POST /api/public/bookings`
  - `GET /api/settings`, `PUT /api/settings`
- Auto-seeds default appointment types

### Email notifications
Supports 3 modes:
1. **Resend API** (recommended, easiest)
2. **SMTP** (fallback)
3. **Simulation mode** (if no email keys configured)

Emails are sent to:
- Client confirmation email
- Owner booking alert email

---

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Open:
- Dashboard: `http://localhost:3000/`
- Public booking page: `http://localhost:3000/book`

---

## Environment config

Copy `.env.example` to `.env` and set:

```env
PORT=3000
BUSINESS_NAME=IntelliSchedule
OWNER_EMAIL=owner@example.com
TIMEZONE=America/Los_Angeles

# Recommended email provider
RESEND_API_KEY=
FROM_EMAIL=bookings@yourdomain.com

# Optional SMTP fallback
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_SECURE=false
```

### Recommended email setup (fuss-free)
Use **Resend**:
1. Create Resend API key
2. Verify sender domain/email
3. Add `RESEND_API_KEY` and `FROM_EMAIL`

Done — emails work immediately.

---

## Why this stack

- **Express + SQLite**: fastest to deploy, zero DB setup pain
- **Single process app**: simpler hosting and maintenance
- **Resend**: high deliverability + easy API
- **Vanilla frontend**: no build step needed, quick edits

---

## Deployment options

### Best easy option
- Deploy to **Render** or **Railway** as a Node web service
- Persist `data.db` on a volume (or move to Postgres later)

### Important
GitHub Pages can host only static files, not this backend.
For full booking + email functionality, run this as a Node app.

---

## Next upgrades (optional)

- Google Calendar sync (2-way)
- Stripe deposits or full payments
- Team calendars / staff assignment
- SMS reminders (Twilio)
- Recurring appointments
- Role-based login (owner + staff)

---

## License
MIT
