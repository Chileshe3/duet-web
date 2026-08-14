import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Same project/bucket as the Android app — public URL + publishable (anon) key,
// safe to embed in a static client like this.
const SUPABASE_URL = "https://qkkijrslbkzuzrzaxixc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_ZzIfFZfWmzSzjqa4Pat-yA_H2B5yqYn";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CHAT_MEDIA_BUCKET = "chat-media";
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // keep in sync with the Android app's limit

export async function uploadChatMedia(coupleId, file) {
  if (file.size > MAX_MEDIA_BYTES) {
    throw new Error("That file is too large to send (25MB limit).");
  }
  const ext = file.name.split(".").pop() || "bin";
  const path = `${coupleId}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from(CHAT_MEDIA_BUCKET)
    .upload(path, file, { contentType: file.type });
  if (error) throw error;

  const { data } = supabase.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path);
  return {
    url: data.publicUrl,
    fileName: path.split("/").pop(),
    sizeBytes: file.size
  };
}

export function mediaTypeFromMime(mimeType) {
  if (mimeType?.startsWith("video/")) return "VIDEO";
  if (mimeType?.startsWith("image/")) return "IMAGE";
  return "IMAGE"; // fallback, shouldn't hit this given the file input's accept filter
}