const crypto = require('crypto');
// Reuse the exact same client db.js already uses for every other query in
// the app. That client is proven to have correct credentials (everything
// else in the app runs through it) — so this avoids a second, independent
// client silently failing because of an env-var name mismatch.
const { supabase } = require('./db');

const BUCKET = 'thumbs';

// Public Storage URLs look like:
//   https://<project>.supabase.co/storage/v1/object/public/thumbs/thumbs/167...jpg
// Pull the object key back out so we can delete it later.
function extractStorageKey(url) {
  const marker = `/object/public/${BUCKET}/`;
  const s = String(url || '');
  const idx = s.indexOf(marker);
  if (idx === -1) return null;
  return s.slice(idx + marker.length);
}

// Best-effort delete — used both when a photo is replaced (old version is
// now orphaned) and when the owning row (product/staff) is deleted outright.
// Never throws: a failed cleanup should never block or fail the save/delete
// the user actually asked for. Free-tier Storage is capped at 1GB, so
// without this, every re-uploaded photo leaves the old blob behind forever
// and that cap creeps up even though the database itself stays small.
async function removeFromStorage(url) {
  const key = extractStorageKey(url);
  if (!key) return;
  try { await supabase.storage.from(BUCKET).remove([key]); } catch (e) { /* ignore */ }
}

// Accepts a "data:image/jpeg;base64,...." string (exactly what makeThumb() in the
// frontend already produces), uploads it to Storage, returns a permanent public URL.
async function uploadBase64ToStorage(dataUrl) {
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!match) return '';
  const contentType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const ext = contentType.split('/')[1] || 'jpg';
  const key = `thumbs/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;

  const { error } = await supabase.storage.from(BUCKET).upload(key, buffer, {
    contentType,
    // Long cache lifetime -- these photos rarely change, so this is what makes repeat
    // views land in the cheap "cached egress" pool instead of hitting Storage's
    // origin (uncached) pool every time. 1 year, in seconds:
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw error;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

module.exports = { uploadBase64ToStorage, removeFromStorage };
