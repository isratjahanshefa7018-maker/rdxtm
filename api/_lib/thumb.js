const { uploadBase64ToStorage, removeFromStorage } = require('./thumbStorage');

// incoming: whatever the frontend sent in `thumb` this request (may be '', a
//           data:image/... base64 string, or an existing URL if untouched).
// existing: the current value already saved in the DB for this row, used as
//           the fallback when the frontend sends nothing new.
//
// IMPORTANT: if the Storage upload fails (bucket missing, network issue,
// bad credentials), we fall back to `existing` rather than throwing — so a
// hiccup uploading a NEW photo never wipes out the photo a row already had.
async function resolveThumb(incoming, existing) {
  const val = String(incoming || '').trim();
  if (!val) return existing || '';
  if (val.startsWith('data:image')) {
    try {
      const url = await uploadBase64ToStorage(val);
      if (!url) return existing || '';
      // Old photo is now orphaned — clean it up so Storage's 1GB free-tier
      // cap doesn't slowly fill with every re-uploaded photo over the
      // years. Fire-and-forget: never let cleanup delay or fail the save.
      if (existing && existing !== url) removeFromStorage(existing);
      return url;
    } catch (e) {
      // Don't let a failed photo upload block saving the rest of the
      // record — but DO log it, so "photo disappeared" is diagnosable
      // from Vercel's function logs instead of failing completely silently.
      console.error('[thumb] Storage upload failed, keeping previous photo:', e && e.message ? e.message : e);
      return existing || '';
    }
  }
  return val; // already a URL -- nothing to do
}

// Call when the OWNING ROW itself is deleted (product removed, staff
// removed, etc.) so its photo doesn't outlive it in Storage.
async function deleteThumb(url) {
  if (url) await removeFromStorage(url);
}

module.exports = { resolveThumb, deleteThumb };
