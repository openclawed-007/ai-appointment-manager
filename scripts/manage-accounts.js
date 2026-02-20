#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { createInterface } = require('readline/promises');
const { stdin, stdout } = require('process');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
require('dotenv').config();

const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'data.db');

const rl = createInterface({ input: stdin, output: stdout });

let sqlite = null;
let pgPool = null;

function printHeader() {
  console.log('\nAccount Manager');
  console.log(`Mode: ${USE_POSTGRES ? 'Postgres' : `SQLite (${DB_PATH})`}`);
  console.log('----------------------------------------');
}

async function dbConnect() {
  if (USE_POSTGRES) {
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: true }
    });
    return;
  }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  sqlite = new Database(DB_PATH);
}

async function dbClose() {
  if (pgPool) await pgPool.end();
  if (sqlite) sqlite.close();
}

async function listAccounts() {
  if (USE_POSTGRES) {
    const result = await pgPool.query(
      `SELECT
         u.id AS user_id,
         u.email,
         u.name,
         u.role,
         b.id AS business_id,
         b.name AS business_name,
         b.slug
       FROM users u
       JOIN businesses b ON b.id = u.business_id
       ORDER BY b.id ASC, u.id ASC`
    );
    return result.rows;
  }
  return sqlite
    .prepare(
      `SELECT
         u.id AS user_id,
         u.email,
         u.name,
         u.role,
         b.id AS business_id,
         b.name AS business_name,
         b.slug
       FROM users u
       JOIN businesses b ON b.id = u.business_id
       ORDER BY b.id ASC, u.id ASC`
    )
    .all();
}

function printAccounts(rows) {
  if (!rows.length) {
    console.log('\nNo accounts found.');
    return;
  }
  console.log('');
  rows.forEach((r) => {
    console.log(
      `User #${r.user_id} (${r.email}) | ${r.name} [${r.role}] | Business #${r.business_id} (${r.business_name}, slug: ${r.slug})`
    );
  });
}

async function deleteUserById(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid user id.');

  if (USE_POSTGRES) {
    const tx = await pgPool.connect();
    try {
      await tx.query('BEGIN');
      const existing = await tx.query('SELECT id, business_id, email FROM users WHERE id = $1', [id]);
      if (!existing.rowCount) {
        await tx.query('ROLLBACK');
        return { ok: false, reason: 'not-found' };
      }
      await tx.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      await tx.query('DELETE FROM users WHERE id = $1', [id]);
      const businessId = Number(existing.rows[0].business_id);
      const remain = await tx.query('SELECT COUNT(*)::int AS c FROM users WHERE business_id = $1', [businessId]);
      await tx.query('COMMIT');
      return {
        ok: true,
        email: existing.rows[0].email,
        businessId,
        remainingUsers: Number(remain.rows[0].c)
      };
    } catch (error) {
      try {
        await tx.query('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      tx.release();
    }
  }

  const existing = sqlite.prepare('SELECT id, business_id, email FROM users WHERE id = ?').get(id);
  if (!existing) return { ok: false, reason: 'not-found' };
  const run = sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    sqlite.prepare('DELETE FROM users WHERE id = ?').run(id);
    const remain = sqlite.prepare('SELECT COUNT(*) AS c FROM users WHERE business_id = ?').get(existing.business_id).c;
    return Number(remain);
  });
  const remainingUsers = run();
  return {
    ok: true,
    email: existing.email,
    businessId: Number(existing.business_id),
    remainingUsers
  };
}

async function deleteBusinessById(businessId) {
  const id = Number(businessId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid business id.');

  if (USE_POSTGRES) {
    const tx = await pgPool.connect();
    try {
      await tx.query('BEGIN');
      const existing = await tx.query('SELECT id, name FROM businesses WHERE id = $1', [id]);
      if (!existing.rowCount) {
        await tx.query('ROLLBACK');
        return { ok: false, reason: 'not-found' };
      }
      await tx.query('DELETE FROM sessions WHERE business_id = $1', [id]);
      await tx.query('DELETE FROM appointments WHERE business_id = $1', [id]);
      await tx.query('DELETE FROM appointment_types WHERE business_id = $1', [id]);
      await tx.query('DELETE FROM business_settings WHERE business_id = $1', [id]);
      await tx.query('DELETE FROM settings WHERE business_id = $1', [id]);
      await tx.query('DELETE FROM users WHERE business_id = $1', [id]);
      await tx.query('DELETE FROM businesses WHERE id = $1', [id]);
      await tx.query('COMMIT');
      return { ok: true, name: existing.rows[0].name };
    } catch (error) {
      try {
        await tx.query('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      tx.release();
    }
  }

  const existing = sqlite.prepare('SELECT id, name FROM businesses WHERE id = ?').get(id);
  if (!existing) return { ok: false, reason: 'not-found' };
  const run = sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM sessions WHERE business_id = ?').run(id);
    sqlite.prepare('DELETE FROM appointments WHERE business_id = ?').run(id);
    sqlite.prepare('DELETE FROM appointment_types WHERE business_id = ?').run(id);
    sqlite.prepare('DELETE FROM business_settings WHERE business_id = ?').run(id);
    sqlite.prepare('DELETE FROM settings WHERE business_id = ?').run(id);
    sqlite.prepare('DELETE FROM users WHERE business_id = ?').run(id);
    sqlite.prepare('DELETE FROM businesses WHERE id = ?').run(id);
  });
  run();
  return { ok: true, name: existing.name };
}

async function confirmDestructive(message) {
  const response = await rl.question(`${message} Type DELETE to confirm: `);
  return response.trim() === 'DELETE';
}

async function main() {
  await dbConnect();
  printHeader();

  let running = true;
  while (running) {
    console.log('\n1) Show all accounts');
    console.log('2) Delete a user by user id');
    console.log('3) Delete a business by business id');
    console.log('4) Exit');
    const choice = (await rl.question('\nChoose option: ')).trim();

    try {
      if (choice === '1') {
        const rows = await listAccounts();
        printAccounts(rows);
      } else if (choice === '2') {
        const userId = await rl.question('Enter user id: ');
        const ok = await confirmDestructive(`Delete user #${userId}?`);
        if (!ok) {
          console.log('Cancelled.');
          continue;
        }
        const result = await deleteUserById(userId);
        if (!result.ok) {
          console.log('User not found.');
        } else {
          console.log(
            `Deleted user ${result.email}. Remaining users in business #${result.businessId}: ${result.remainingUsers}.`
          );
          if (result.remainingUsers === 0) {
            console.log('Warning: this business now has no users. Consider deleting that business.');
          }
        }
      } else if (choice === '3') {
        const businessId = await rl.question('Enter business id: ');
        const ok = await confirmDestructive(`Delete business #${businessId} and all its data?`);
        if (!ok) {
          console.log('Cancelled.');
          continue;
        }
        const result = await deleteBusinessById(businessId);
        if (!result.ok) console.log('Business not found.');
        else console.log(`Deleted business: ${result.name}`);
      } else if (choice === '4') {
        running = false;
      } else {
        console.log('Unknown option.');
      }
    } catch (error) {
      console.error(`Error: ${error.message}`);
    }
  }

  await dbClose();
  rl.close();
  console.log('Done.');
}

main().catch(async (error) => {
  console.error(error);
  try {
    await dbClose();
  } catch {}
  rl.close();
  process.exit(1);
});
