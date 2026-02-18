# IntelliSchedule

Sleek appointment management software with:
- Flexible appointment types for **any business**
- Owner dashboard + public booking page
- Automatic confirmation/owner notification emails
- AI-style insights based on real booking data
- Free persistent DB option via Postgres (Neon) with SQLite fallback

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
- Express API with **Postgres-first** architecture (`pg`) and SQLite fallback
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

# Recommended: free persistent Postgres (Neon)
DATABASE_URL=

# Optional fallback when DATABASE_URL is empty
DB_PATH=./data/data.db

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

- **Express + Postgres-first**: persistent data on free-tier DB providers (like Neon)
- **SQLite fallback**: easy local/dev mode when no DB URL is set
- **Single process app**: simpler hosting and maintenance
- **Resend**: high deliverability + easy API
- **Vanilla frontend**: no build step needed, quick edits

---

## Deployment options

### Best easy option: Render (recommended)
This repo includes `render.yaml` for one-click **Free instance** deploy.

1. Push repo to GitHub (already done)
2. In Render: **New + → Blueprint**
3. Select this repo and deploy
4. Create a free Neon Postgres project and copy its connection string
5. In Render service settings, add secrets:
   - `DATABASE_URL` (from Neon)
   - `OWNER_EMAIL`
   - `FROM_EMAIL`
   - `RESEND_API_KEY` (recommended)
6. Open `/api/health` to confirm service is live (`db` should say `postgres`)

The blueprint already configures:
- Node runtime
- health check
- start/build commands
- free instance settings

> Best free reliability: use `DATABASE_URL` (Neon Postgres). This avoids Render free filesystem resets.
> SQLite remains available as fallback for local development.

### Railway (alternative)
1. New project from GitHub repo
2. Add environment variables from `.env.example`
3. Add a persistent volume and set `DB_PATH` to that mounted path
4. Deploy

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
