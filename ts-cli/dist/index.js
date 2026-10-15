#!/usr/bin/env node
// meow — MeoW push CLI (TypeScript edition).
//
// Zero runtime dependencies; requires Node.js >= 18.17 (built-in fetch).
// Behaviour-compatible with the Rust CLI in rust-cli/.
//
// Push API: https://www.chuckfang.com/MeoW/api_doc.html
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { DEFAULT_BASE_URL, DEFAULT_TITLE, UncertainError, buildPlan, configPath, execute, hintFor, loadFileConfig, saveFileConfig, validateBaseUrl, } from './core.js';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const VERSION = pkg.version ?? '0.0.0';
const NODE_MAJOR = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
if (!Number.isFinite(NODE_MAJOR) || NODE_MAJOR < 18) {
    console.error(`✘ meow 需要 Node.js 18.17 或更高版本（当前 ${process.versions.node}）`);
    process.exit(2);
}
const OPTIONS = {
    nickname: { type: 'string', short: 'n' },
    title: { type: 'string', short: 't' },
    url: { type: 'string', short: 'u' },
    'img-url': { type: 'string' },
    html: { type: 'boolean' },
    text: { type: 'boolean' },
    'msg-type': { type: 'string' },
    'html-height': { type: 'string' },
    method: { type: 'string', short: 'm', default: 'post' },
    timeout: { type: 'string', default: '15' },
    'dry-run': { type: 'boolean' },
    json: { type: 'boolean' },
    'base-url': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'V' },
};
function helpText() {
    return `meow ${VERSION} — MeoW 消息推送 CLI（api.chuckfang.com，零依赖 TypeScript 版）

用法：
  meow push [选项] [昵称] <消息>
  meow config [set <配置项> <值>]

昵称优先级：位置参数 > --nickname > 环境变量 MEOW_NICKNAME > 配置文件
API 地址优先级：--base-url > 环境变量 MEOW_BASE_URL > 配置文件 > 默认 ${DEFAULT_BASE_URL}

注意：推送接口不幂等，本工具不会自动重试；失败后请先确认再决定是否重发。

选项：
  -n, --nickname <NAME>      接收者昵称
  -t, --title <TITLE>        消息标题，省略时默认 ${DEFAULT_TITLE}
  -u, --url <URL>            点击通知后跳转的链接
      --img-url <URL>        通知图标 URL（建议 216×216 PNG）
      --html                 以 HTML 渲染消息（等价于 --msg-type html）
      --text                 以纯文本发送（默认）
      --msg-type <text|html> 消息显示类型
      --html-height <PX>     HTML 显示高度（像素，隐含 HTML 类型）
  -m, --method <get|post>    请求方法，默认 post
      --timeout <SECONDS>    HTTP 超时，默认 15
      --dry-run              只打印将要发送的请求，不实际发送
      --json                 以单行 JSON 输出结果，便于程序解析
      --base-url <URL>       覆盖 API 基地址
  -h, --help                 显示帮助
  -V, --version              显示版本

示例：
  meow push Azathoth "服务部署完成"
  meow push Azathoth "<b>构建成功</b>" --html --title 系统通知 -u https://ci.example.com
  meow push Azathoth - < long.txt
  meow push Azathoth "预览请求" --dry-run
  meow config set nickname Azathoth`;
}
function configHelpText() {
    return `用法：meow config [set <配置项> <值>]

  meow config                    显示配置文件路径与当前值
  meow config set nickname <昵称>  设置默认昵称
  meow config set title <标题>     设置默认标题
  meow config set base_url <URL>  覆盖 API 基地址

值为空字符串时清除该项。`;
}
function usageError(message) {
    console.error(`✘ ${message}`);
    console.error('运行 meow --help 查看用法');
    return 2;
}
function fail(message, json) {
    if (json) {
        console.log(JSON.stringify({ ok: false, msg: message }));
    }
    else {
        console.error(`✘ ${message}`);
    }
    return 1;
}
function printJsonReport(report) {
    try {
        console.log(JSON.stringify(report));
    }
    catch (err) {
        console.error(`✘ 序列化输出失败：${err instanceof Error ? err.message : String(err)}`);
    }
}
function isControlChar(char) {
    const code = char.codePointAt(0) ?? 0;
    return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}
async function runPush(values, positionals) {
    const jsonMode = values.json === true;
    if (positionals.length < 1 || positionals.length > 2) {
        return usageError('push 需要 1 到 2 个位置参数：<消息> 或 <昵称> <消息>');
    }
    let config;
    try {
        config = loadFileConfig();
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err), jsonMode);
    }
    const flagNickname = values.nickname ?? process.env.MEOW_NICKNAME;
    const [first, second] = positionals;
    let nickname;
    let rawMessage;
    if (second !== undefined) {
        if (flagNickname !== undefined && flagNickname !== first) {
            return fail(`位置参数中的昵称“${first}”与 --nickname“${flagNickname}”冲突`, jsonMode);
        }
        nickname = first ?? '';
        rawMessage = second;
    }
    else {
        if (flagNickname !== undefined) {
            nickname = flagNickname;
        }
        else if (config.nickname !== undefined && config.nickname.trim() !== '') {
            nickname = config.nickname;
        }
        else {
            return fail('缺少接收者昵称。用法：meow push <昵称> <消息>，或先用 meow config set nickname <昵称> 设置默认昵称', jsonMode);
        }
        rawMessage = first ?? '';
    }
    nickname = nickname.trim();
    if (nickname === '')
        return fail('昵称不能为空', jsonMode);
    if (nickname.includes('/'))
        return fail(`昵称不允许包含斜杠：${nickname}`, jsonMode);
    if (Array.from(nickname).some(isControlChar)) {
        return fail('昵称包含控制字符，请检查输入', jsonMode);
    }
    let message = rawMessage;
    if (message === '-') {
        try {
            message = readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
        }
        catch (err) {
            return fail(`读取标准输入失败：${err instanceof Error ? err.message : String(err)}`, jsonMode);
        }
    }
    if (message.trim() === '')
        return fail('消息内容不能为空', jsonMode);
    let title;
    if (values.title !== undefined) {
        if (values.title === '') {
            return fail(`标题不能为空；省略 --title 时默认使用 ${DEFAULT_TITLE}`, jsonMode);
        }
        title = values.title;
    }
    else if (config.title !== undefined && config.title !== '') {
        title = config.title;
    }
    if (values.html === true && values.text === true) {
        return usageError('参数冲突：--html 与 --text 不能同时使用');
    }
    if (values.html === true && values['msg-type'] !== undefined) {
        return usageError('参数冲突：--html 与 --msg-type 不能同时使用');
    }
    if (values.text === true && values['msg-type'] !== undefined) {
        return usageError('参数冲突：--text 与 --msg-type 不能同时使用');
    }
    const msgTypeRaw = values['msg-type'];
    if (msgTypeRaw !== undefined && msgTypeRaw !== 'text' && msgTypeRaw !== 'html') {
        return usageError('--msg-type 只能是 text 或 html');
    }
    const methodRaw = values.method ?? 'post';
    if (methodRaw !== 'get' && methodRaw !== 'post') {
        return usageError('--method 只能是 get 或 post');
    }
    const timeout = Number(values.timeout ?? '15');
    if (!Number.isInteger(timeout) || timeout <= 0) {
        return usageError('--timeout 必须是正整数秒');
    }
    const htmlHeightRaw = values['html-height'];
    let htmlHeight = 200;
    if (htmlHeightRaw !== undefined) {
        const parsed = Number(htmlHeightRaw);
        if (!Number.isInteger(parsed)) {
            return usageError('--html-height 必须是整数');
        }
        if (parsed <= 0) {
            return fail('--html-height 必须大于 0', jsonMode);
        }
        htmlHeight = parsed;
    }
    const explicitType = msgTypeRaw === 'text' || msgTypeRaw === 'html'
        ? msgTypeRaw
        : values.html === true
            ? 'html'
            : values.text === true
                ? 'text'
                : undefined;
    if (explicitType === 'text' && htmlHeightRaw !== undefined) {
        return fail('--html-height 仅在 HTML 消息（--html 或 --msg-type html）时可用', jsonMode);
    }
    const msgType = explicitType ?? (htmlHeightRaw !== undefined ? 'html' : 'text');
    const rawBaseUrl = values['base-url'] ?? process.env.MEOW_BASE_URL ?? config.base_url ?? DEFAULT_BASE_URL;
    let baseUrl;
    try {
        baseUrl = validateBaseUrl(rawBaseUrl);
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err), jsonMode);
    }
    const request = {
        nickname,
        ...(title !== undefined ? { title } : {}),
        message,
        ...(values.url !== undefined ? { url: values.url } : {}),
        ...(values['img-url'] !== undefined ? { imgUrl: values['img-url'] } : {}),
        msgType,
        htmlHeight,
        method: methodRaw,
        baseUrl,
    };
    let plan;
    try {
        plan = buildPlan(request);
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err), jsonMode);
    }
    if (values['dry-run'] === true) {
        if (jsonMode) {
            console.log(JSON.stringify({
                dry_run: true,
                method: plan.method.toUpperCase(),
                url: plan.url,
                content_type: plan.method === 'post' ? 'application/json' : null,
                body: plan.body ?? null,
            }, null, 2));
        }
        else {
            console.log(`${plan.method.toUpperCase()} ${plan.url}`);
            if (plan.body !== undefined) {
                console.log('Content-Type: application/json');
                console.log();
                console.log(JSON.stringify(plan.body, null, 2));
            }
        }
        return 0;
    }
    let outcome;
    try {
        outcome = await execute(plan, timeout);
    }
    catch (err) {
        if (err instanceof UncertainError) {
            return fail(err.message, jsonMode);
        }
        return fail(`请求失败：${err instanceof Error ? err.message : String(err)}`, jsonMode);
    }
    const report = { ok: outcome.ok };
    report.status = outcome.apiStatus;
    report.http_status = outcome.httpStatus;
    if (outcome.serverMsg !== undefined)
        report.msg = outcome.serverMsg;
    if (outcome.data !== undefined)
        report.data = outcome.data;
    report.nickname = nickname;
    if (!outcome.ok) {
        const hint = hintFor(outcome.apiStatus);
        if (hint !== undefined)
            report.hint = hint;
    }
    if (jsonMode) {
        printJsonReport(report);
    }
    else if (outcome.ok) {
        console.log(`✔ ${outcome.serverMsg ?? '发送成功'}（接收者：${nickname}）`);
    }
    else {
        console.error(`✘ 推送失败（业务状态码 ${outcome.apiStatus}）：${outcome.serverMsg ?? '未知错误'}`);
        const hint = hintFor(outcome.apiStatus);
        if (hint !== undefined)
            console.error(`  提示：${hint}`);
    }
    return outcome.ok ? 0 : 1;
}
function runConfig(positionals) {
    let file;
    try {
        file = configPath();
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err), false);
    }
    if (positionals.length === 0) {
        let config;
        try {
            config = loadFileConfig();
        }
        catch (err) {
            return fail(err instanceof Error ? err.message : String(err), false);
        }
        console.log(`配置文件：${file}`);
        console.log(`nickname = ${config.nickname ?? '（未设置）'}`);
        console.log(`title    = ${config.title ?? `（未设置，默认 ${DEFAULT_TITLE}）`}`);
        console.log(`base_url = ${config.base_url ?? DEFAULT_BASE_URL}`);
        return 0;
    }
    if (positionals[0] === 'set' && positionals.length === 3) {
        const key = positionals[1] ?? '';
        const value = positionals[2] ?? '';
        let config;
        try {
            config = loadFileConfig();
        }
        catch (err) {
            return fail(err instanceof Error ? err.message : String(err), false);
        }
        const cleared = value === '';
        switch (key) {
            case 'nickname':
                if (cleared)
                    delete config.nickname;
                else
                    config.nickname = value;
                break;
            case 'title':
                if (cleared)
                    delete config.title;
                else
                    config.title = value;
                break;
            case 'base_url':
            case 'base-url':
                if (!cleared) {
                    try {
                        validateBaseUrl(value);
                    }
                    catch (err) {
                        return fail(err instanceof Error ? err.message : String(err), false);
                    }
                    config.base_url = value;
                }
                else {
                    delete config.base_url;
                }
                break;
            default:
                return usageError(`未知配置项“${key}”；可选：nickname、title、base_url`);
        }
        let saved;
        try {
            saved = saveFileConfig(config);
        }
        catch (err) {
            return fail(err instanceof Error ? err.message : String(err), false);
        }
        if (cleared) {
            console.log(`已清除 ${key}（${saved}）`);
        }
        else {
            console.log(`已更新 ${key}（${saved}）`);
        }
        return 0;
    }
    return usageError(configHelpText());
}
async function main(argv) {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: OPTIONS });
    }
    catch (err) {
        console.error(`✘ ${err instanceof Error ? err.message : String(err)}`);
        console.error('运行 meow --help 查看用法');
        return 2;
    }
    const values = parsed.values;
    const positionals = parsed.positionals;
    if (values.version === true) {
        console.log(`meow ${VERSION}`);
        return 0;
    }
    if (values.help === true) {
        console.log(helpText());
        return 0;
    }
    const command = positionals[0];
    if (command === undefined) {
        console.error(helpText());
        return 2;
    }
    if (command === 'push') {
        return runPush(values, positionals.slice(1));
    }
    if (command === 'config') {
        return runConfig(positionals.slice(1));
    }
    console.error(`✘ 未知子命令“${command}”`);
    console.error('运行 meow --help 查看用法');
    return 2;
}
process.exitCode = await main(process.argv.slice(2));
