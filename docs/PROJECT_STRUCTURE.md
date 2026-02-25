# Project Structure

## Backend entrypoint
- `src/server.js`: composition root. Loads middleware, registers route modules, bootstraps DB and server process.

## Route modules (`src/routes/`)
- `auth.js`: authentication routes + API auth middleware.
- `settings.js`: business settings read/update routes.
- `data.js`: export/import + AI import quota/import routes.
- `types.js`: appointment type CRUD routes.
- `clients.js`: client, notes, and client-appointment routes.
- `appointments.js`: appointment/calendar/public booking routes.
- `dashboard.js`: notifications + dashboard summary routes.
- `pages.js`: page/document routes (`/`, `/book`, `/reset-password`, `/verify-email`).

## Core backend libraries (`src/lib/`)
- `db.js`: schema, migrations, db adapters/helpers.
- `appointments.js`: appointment business rules (overlap, slots, parsing).
- `auth.js`: session/cookie/password/token primitives.
- `insights.js`: dashboard insight generation.
- `data.js`: backup import/export + AI import orchestration.
- `email.js`: email rendering/sending helpers.

## Frontend (`public/`)
- `app.js`: main dashboard SPA logic.
- `booking.js`: public booking page behavior.
- `reset-password.js`: reset flow UI.
- `styles.css` + `css/`: UI styling.
- `index.html`, `booking.html`, `reset-password.html`: app entry pages.
- `logo/`, favicons, `manifest.webmanifest`, `sw.js`: static assets and PWA files.

## Tests
- `tests/api.test.js`: API integration coverage.
- `tests/settings.test.js`: settings + filtered export behaviors.
- `tests/ui.test.js`: frontend utility behavior.
- `tests/insights.test.js`: insight logic coverage.
