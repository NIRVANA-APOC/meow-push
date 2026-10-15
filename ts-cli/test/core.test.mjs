import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPlan } from '../dist/core.js';

function request(method) {
  return {
    nickname: 'Azathoth',
    title: '系统通知',
    message: '你好<b>世界',
    url: 'https://example.com/a b',
    msgType: 'html',
    htmlHeight: 300,
    method,
    baseUrl: 'https://api.chuckfang.com',
  };
}

test('GET plan encodes path and query', () => {
  const plan = buildPlan(request('get'));
  assert.equal(plan.method, 'get');
  assert.ok(
    plan.url.startsWith(
      'https://api.chuckfang.com/Azathoth/%E7%B3%BB%E7%BB%9F%E9%80%9A%E7%9F%A5/%E4%BD%A0%E5%A5%BD%3Cb%3E%E4%B8%96%E7%95%8C',
    ),
    plan.url,
  );
  assert.ok(plan.url.includes('msgType=html'), plan.url);
  assert.ok(plan.url.includes('htmlHeight=300'), plan.url);
  assert.ok(
    plan.url.includes('url=https%3A%2F%2Fexample.com%2Fa+b') ||
      plan.url.includes('url=https%3A%2F%2Fexample.com%2Fa%20b'),
    plan.url,
  );
  assert.equal(plan.body, undefined);
});

test('GET plan without title uses the short path', () => {
  const req = request('get');
  delete req.title;
  req.message = 'hello world';
  const plan = buildPlan(req);
  assert.ok(plan.url.startsWith('https://api.chuckfang.com/Azathoth/hello%20world?'), plan.url);
});

test('GET plan rejects slashes in path segments', () => {
  const req = request('get');
  req.message = 'a/b';
  assert.throws(() => buildPlan(req), /斜杠/);

  const withTitle = request('get');
  withTitle.message = 'fine';
  withTitle.title = 'a/b';
  assert.throws(() => buildPlan(withTitle), /斜杠/);
});

test('POST plan keeps type in query and fields in body', () => {
  const plan = buildPlan(request('post'));
  assert.equal(plan.method, 'post');
  assert.equal(plan.url, 'https://api.chuckfang.com/Azathoth?msgType=html&htmlHeight=300');
  assert.deepEqual(plan.body, {
    title: '系统通知',
    msg: '你好<b>世界',
    url: 'https://example.com/a b',
  });
});

test('POST plan omits title when absent and uses text type', () => {
  const req = request('post');
  delete req.title;
  req.msgType = 'text';
  const plan = buildPlan(req);
  assert.equal(plan.url, 'https://api.chuckfang.com/Azathoth?msgType=text');
  assert.equal(plan.body.title, undefined);
  assert.equal(plan.body.msg, '你好<b>世界');
});
