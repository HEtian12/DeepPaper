const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function validateEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return { ok: false, error: "Whisper 服务地址无效。" };
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname) || url.username || url.password) {
    return { ok: false, error: "为保护录音隐私，只允许连接本机 http://localhost、127.0.0.1 或 [::1] 服务。" };
  }
  return { ok: true, url };
}

async function transcribeWithWhisper({ endpoint, audio, mimeType = "audio/webm" } = {}) {
  const checked = validateEndpoint(endpoint);
  if (!checked.ok) return checked;
  const bytes = Buffer.from(audio || []);
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) return { ok: false, error: "录音为空或超过 25 MB 限制。" };
  const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : mimeType.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), `recording.${extension}`);
  form.append("temperature", "0");
  form.append("temperature_inc", "0");
  form.append("response_format", "json");
  try {
    const response = await fetch(checked.url, { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(180_000) });
    const body = await response.text();
    if (!response.ok) return { ok: false, error: `本地 Whisper 返回 HTTP ${response.status}：${body.slice(0, 500)}` };
    let result;
    try { result = JSON.parse(body); } catch { return { ok: false, error: "Whisper 响应不是有效 JSON。" }; }
    const text = String(result?.text || "").trim();
    return text ? { ok: true, text } : { ok: false, error: "没有识别到语音内容。" };
  } catch (error) {
    return { ok: false, error: error.name === "TimeoutError" ? "本地语音识别超时。" : `无法连接本地 Whisper：${error.message}` };
  }
}

module.exports = { MAX_AUDIO_BYTES, validateEndpoint, transcribeWithWhisper };
