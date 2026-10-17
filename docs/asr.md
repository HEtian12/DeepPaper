# Local ASR Setup

DeepPaper's Agent can record up to two minutes of speech and transcribe it with a local `whisper.cpp` HTTP server. Audio is sent only to a loopback address (`localhost`, `127.0.0.1`, or `[::1]`) through Electron's main process. The transcript is inserted into the task box for review; it is never submitted automatically.

## Start the local server

Install or build `whisper.cpp`, download a multilingual Whisper model such as `ggml-base.bin`, and install FFmpeg. Start the server from the whisper.cpp folder:

```powershell
.\build\bin\whisper-server.exe -m .\models\ggml-base.bin --host 127.0.0.1 --port 8080 --convert --language auto
```

`--convert` lets the server decode the WebM/Opus audio produced by Chromium's `MediaRecorder`; whisper.cpp requires FFmpeg for this conversion. The app's default endpoint is `http://127.0.0.1:8080/inference`. Keep the server bound to loopback and do not run it with administrator privileges.

Open DeepPaper's **文献 Agent**, expand **本地语音识别设置**, then click **开始录音**. Click again to stop. The recognized text is added to the task input and can be edited before clicking **开始执行**.

If no local server is running, normal text-based Agent usage is unaffected. Microphone permission is requested only when recording starts.
