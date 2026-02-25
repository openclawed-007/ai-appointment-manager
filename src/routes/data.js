'use strict';

function registerDataRoutes(app, deps) {
  const {
    exportBusinessData,
    importBusinessData,
    importAiAppointments,
    getSettings,
    getAiImportQuotaStatus,
    consumeAiImportQuota
  } = deps;

// ── Data export/import ────────────────────────────────────────────────────────

app.get('/api/data/export', async (req, res) => {
  res.json(await exportBusinessData(req.auth.businessId));
});

app.post('/api/data/import', async (req, res) => {
  const businessId = req.auth.businessId;
  const imported = await importBusinessData(businessId, req.body || {});
  const settings = await getSettings(businessId);
  res.json({ ok: true, importedTypes: imported.importedTypes, importedAppointments: imported.importedAppointments, settings });
});

app.get('/api/data/import-ai/quota', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const quota = await getAiImportQuotaStatus(req.auth.businessId, today, 3);
    return res.json({ quota });
  } catch (error) {
    const statusCode = Number(error?.statusCode || 400);
    return res.status(statusCode).json({ error: error.message || 'Unable to load AI import quota.' });
  }
});

app.post('/api/data/import-ai', async (req, res) => {
  try {
    const businessId = req.auth.businessId;
    const { fileName, fileContent } = req.body || {};
    if (!String(fileContent || '').trim()) {
      return res.status(400).json({ error: 'fileContent is required.' });
    }
    if (!String(process.env.OPENROUTER_API_KEY || '').trim()) {
      return res.status(503).json({ error: 'OPENROUTER_API_KEY is not configured on the server.' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const quota = await consumeAiImportQuota(businessId, today, 3);
    if (!quota.allowed) {
      return res.status(429).json({
        error: `AI import limit reached for ${today}. Maximum is ${quota.limit} per day.`,
        quota
      });
    }

    const result = await importAiAppointments(businessId, { fileName, fileContent });
    return res.json({ ok: true, quota, ...result });
  } catch (error) {
    const statusCode = Number(error?.statusCode || 400);
    return res.status(statusCode).json({ error: error.message || 'AI import failed.' });
  }
});

}

module.exports = registerDataRoutes;
