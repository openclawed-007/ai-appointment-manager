'use strict';

const crypto = require('crypto');

function hashPassword(password = '') {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function isValidEmailFormat(value = '') {
  const email = String(value || '').trim();
  if (!email) return false;
  if (email.length > 320) return false;
  // Practical validation: one @, no spaces, dot in domain, no consecutive dots.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  if (email.includes('..')) return false;
  return true;
}

module.exports = {
  hashPassword,
  isValidEmailFormat
};
