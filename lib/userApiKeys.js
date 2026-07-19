const supabase = require('./supabaseClient');

// Hides most of an API key, showing only the first 6 and last 4 chars,
// so users can tell their own keys apart without the full secret ever
// being redisplayed in the chat.
function maskApiKey(key) {
  if (!key || key.length < 10) return '****';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

async function getUserApiKeysList(userId) {
  const { data, error } = await supabase
    .from('user_api_keys')
    .select('id, api_key, added_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('added_at', { ascending: true });
  if (error) {
    console.error('getUserApiKeysList error:', error.message);
    return [];
  }
  return data;
}

async function addUserApiKeyToDb(userId, apiKey) {
  const { error } = await supabase
    .from('user_api_keys')
    .upsert(
      { user_id: userId, api_key: apiKey, is_active: true },
      { onConflict: 'user_id,api_key' }
    );
  if (error) {
    console.error('addUserApiKeyToDb error:', error.message);
    return false;
  }
  return true;
}

async function removeUserApiKeyFromDb(id, userId) {
  const { error } = await supabase.from('user_api_keys').delete().eq('id', id).eq('user_id', userId);
  if (error) {
    console.error('removeUserApiKeyFromDb error:', error.message);
    return false;
  }
  return true;
}

// Validates a candidate key by actually calling Google's lightweight
// ListModels endpoint (no generation quota consumed) before it's saved.
// No regex/format pre-check — whatever the user pastes goes straight to
// this live check.
async function validateGeminiApiKey(apiKey) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.models)) return { valid: true };
      return { valid: false, reason: 'Unexpected response from Google.' };
    }
    const errBody = await res.text();
    let reason = errBody;
    try {
      reason = JSON.parse(errBody)?.error?.message || errBody;
    } catch (_) {
      /* leave as raw text */
    }
    return { valid: false, reason };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

module.exports = {
  maskApiKey,
  getUserApiKeysList,
  addUserApiKeyToDb,
  removeUserApiKeyFromDb,
  validateGeminiApiKey,
};
