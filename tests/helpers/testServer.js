const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');

async function waitForHealthy(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.status === 200) return;
    } catch {
      // server not accepting connections yet — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

// Spawns the real server.js as a child process on its own port, so
// integration tests exercise the actual app instead of an imported mock.
async function startTestServer(port) {
  const logLines = [];
  const child = spawn('node', ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port) },
  });

  child.stdout.on('data', (chunk) => logLines.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logLines.push(chunk.toString()));

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  const baseUrl = `http://localhost:${port}`;

  try {
    await waitForHealthy(baseUrl, 15000);
  } catch (err) {
    child.kill();
    throw new Error(`${err.message}\n--- server output ---\n${logLines.join('')}`);
  }

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exitPromise;
    }
  }

  return { baseUrl, stop, logLines };
}

module.exports = { startTestServer };
