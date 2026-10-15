import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'dist', 'index.js');

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr };
  } catch (err) {
    return {
      status: typeof err.code === 'number' ? err.code : 1,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : String(err.message ?? err),
    };
  }
}

function withMockServer(response, fn) {
  return new Promise((resolve, reject) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const base = `http://127.0.0.1:${address.port}`;
      Promise.resolve()
        .then(() => fn(base, requests))
        .then(
          (value) => server.close(() => resolve(value)),
          (err) => server.close(() => reject(err)),
        );
    });
  });
}

test('POST round-trip against a mock server', async () => {
  await withMockServer({ status: 200, data: true, msg: '发送成功' }, async (base, requests) => {
    const result = await runCli(['push', 'Azathoth', 'hello 世界', '--base-url', base, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.status, 200);
    assert.equal(report.nickname, 'Azathoth');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/Azathoth?msgType=text');
    assert.deepEqual(JSON.parse(requests[0].body), { msg: 'hello 世界' });
  });
});

test('business failure reports status, hint and exits 1', async () => {
  await withMockServer({ status: 404, data: false, msg: '发送失败，该昵称没有注册' }, async (base) => {
    const result = await runCli(['push', 'Nobody', 'hi', '--base-url', base, '--json']);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.status, 404);
    assert.ok(report.hint);
  });
});

test('dry-run prints the request without contacting the server', async () => {
  const result = await runCli([
    'push',
    'Azathoth',
    'hello',
    '--method',
    'get',
    '--dry-run',
    '--base-url',
    'http://127.0.0.1:9',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^GET http:\/\/127\.0\.0\.1:9\/Azathoth\/hello\?msgType=text/);
});

test('config set nickname is used when the nickname is omitted', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'meow-ts-'));
  const env = { XDG_CONFIG_HOME: tmp, APPDATA: tmp };
  try {
    const set = await runCli(['config', 'set', 'nickname', 'Azathoth'], env);
    assert.equal(set.status, 0, set.stderr);

    const dry = await runCli(['push', 'hello', '--dry-run'], env);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /^POST https:\/\/api\.chuckfang\.com\/Azathoth\?msgType=text/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
