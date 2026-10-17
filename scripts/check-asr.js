const assert = require("node:assert/strict");
const http = require("node:http");
const { MAX_AUDIO_BYTES, validateEndpoint, transcribeWithWhisper } = require("../electron/asr.js");

async function main() {
  assert.equal(validateEndpoint("https://127.0.0.1:8080/inference").ok, false);
  assert.equal(validateEndpoint("http://example.com/inference").ok, false);
  assert.equal(validateEndpoint("http://127.0.0.1:8080/inference").ok, true);
  assert.equal((await transcribeWithWhisper({ endpoint: "http://127.0.0.1:8080/inference", audio: [] })).ok, false);
  assert.equal((await transcribeWithWhisper({ endpoint: "http://127.0.0.1:8080/inference", audio: Buffer.alloc(MAX_AUDIO_BYTES + 1) })).ok, false);

  let receivedBody = "";
  const server = http.createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/inference");
    assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
    request.setEncoding("utf8");
    request.on("data", (chunk) => { receivedBody += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "local transcript" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const result = await transcribeWithWhisper({
      endpoint: `http://127.0.0.1:${port}/inference`,
      audio: Buffer.from("fake-webm"),
      mimeType: "audio/webm"
    });
    assert.deepEqual(result, { ok: true, text: "local transcript" });
    assert.match(receivedBody, /name="file"; filename="recording\.webm"/);
    assert.match(receivedBody, /name="response_format"\r\n\r\njson/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  console.log("ASR checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
