# IntelliBook

Sleek appointment management software with:
- Flexible appointment types for **any business**
- Owner dashboard + public booking page
- Multi-tenant owner accounts (each business has isolated data)
- Automatic confirmation/owner notification emails
- AI-style insights based on real booking data
- Offline PWA support with service worker
- Free persistent DB option via Postgres (Neon) with SQLite fallback

---

## What's implemented

### Frontend
- Keeps your calm/sleek style and animations
- Dashboard (`/`) with:
  - Stats cards (today/week/pending/optimized)
  - Today timeline
  - Appointment type manager view
  - AI insights panel
  - New appointment modal wired to backend
  - Calendar view with month navigation and day actions
  - Settings panel with business hours, timezone, and appearance options
- Public booking page (`/book`) for customers
- Owner auth: signup/login/logout with email verification, session-based
- Password reset flow
- Mobile-responsive with bottom navigation
- Dark/light theme support (persisted)
- Offline support: PWA shell with mutation queue and reconnect sync

### Backend
- Express API with **Postgres-first** architecture (`pg`) and SQLite fallback
- Modular server architecture with separated concerns
- Route/module map: see [`docs/PROJECT_STRUCTURE.md`](docs/PROJECT_STRUCTURE.md)
- Security: Helmet headers, CSRF protection, rate limiting
- Endpoints:
  - `GET /api/health` - Health check with DB status
  - `GET /api/dashboard` - Dashboard stats and data
  - `GET /api/appointments` - List appointments
  - `POST /api/appointments` - Create appointment
  - `PUT /api/appointments/:id` - Update appointment
  - `DELETE /api/appointments/:id` - Delete appointment
  - `PATCH /api/appointments/:id/status` - Update status (confirmed/cancelled/completed)
  - `POST /api/appointments/:id/email` - Send email to client
  - `GET /api/calendar/month` - Get appointments for calendar view
  - `GET /api/types` - List appointment types
  - `POST /api/types` - Create type
  - `PUT /api/types/:id` - Update type
  - `DELETE /api/types/:id` - Delete type
  - `GET /api/public/available-slots` - Get available booking slots
  - `POST /api/public/bookings` - Public booking endpoint
  - `GET /api/settings`, `PUT /api/settings` - Business settings
  - `GET /api/notifications` - Notification list
  - `GET /api/data/export` - Export business data
  - `POST /api/data/import` - Import business data
  - `GET /api/data/import-ai/quota`, `POST /api/data/import-ai` - AI import with quota
  - Auth: `POST /api/auth/signup`, `POST /api/auth/verify-email`, `POST /api/auth/login`, `POST /api/auth/login/resend-code`, `POST /api/auth/login/verify-code`, `POST /api/auth/password-reset/request`, `POST /api/auth/password-reset/confirm`, `POST /api/auth/logout`, `GET /api/auth/me`
- Auto-seeds default appointment types

### Email notifications
Supports 3 modes:
1. **Resend API** (recommended, easiest)
2. **SMTP** (fallback)
3. **Simulation mode** (if no email keys configured)

Emails are sent to:
- Client confirmation email
- Owner booking alert email
- Appointment update notifications (date/time changes)
- Cancellation emails with reason

---

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Open:
- Dashboard: `http://localhost:3000/`
- Public booking page: `http://localhost:3000/book?business=your-business-slug`

## Manage test accounts locally

Run:

```bash
npm run accounts:manage
```

Menu options:
- Show all accounts
- Delete a user by user id
- Delete a business by business id (removes all its data)

---

## Environment config

Copy `.env.example` to `.env` and set:

```env
PORT=3000

# Preferred (free + persistent): Postgres (e.g. Neon)
DATABASE_URL=

# Fallback local SQLite (used when DATABASE_URL is empty)
DB_PATH=./data/data.db

# Business settings
BUSINESS_NAME=IntelliBook
OWNER_EMAIL=owner@example.com
TIMEZONE=America/Los_Angeles

# Email setup (choose one)
# 1) Resend (recommended, easiest)
RESEND_API_KEY=
FROM_EMAIL=bookings@yourdomain.com

# 2) SMTP fallback
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
- **PWA**: works offline, syncs when reconnected

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

## Testing

Run the test suite:

```bash
npm test
```

Tests cover:
- API endpoints (CRUD operations)
- UI behavior
- Settings management
- Insights calculations

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
