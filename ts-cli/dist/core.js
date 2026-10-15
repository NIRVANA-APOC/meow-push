// Core logic for the meow CLI (TypeScript edition).
//
// Zero runtime dependencies: uses the built-in fetch (Node >= 18.17).
// Behaviour-compatible with the Rust implementation in rust-cli/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
export const DEFAULT_BASE_URL = 'https://api.chuckfang.com';
export const DEFAULT_TITLE = 'MeoW';
export const MAX_GET_URL_LEN = 7500;
/** Transport-level or non-JSON failure: delivery is unknown, do not retry blindly. */
export class UncertainError extends Error {
}
export function validateBaseUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error(`API 基地址无效：${value}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`API 基地址必须是 http/https：${value}`);
    }
    return value;
}
function trimTrailingSlashes(value) {
    return value.replace(/\/+$/, '');
}
export function buildPlan(req) {
    const base = trimTrailingSlashes(req.baseUrl);
    if (req.method === 'get') {
        // The server front end (Tomcat) rejects encoded slashes (%2F) with HTTP 400,
        // so no GET path segment may contain "/".
        const segments = [[req.nickname, '昵称']];
        if (req.title !== undefined)
            segments.push([req.title, '标题']);
        segments.push([req.message, '消息']);
        for (const [value, what] of segments) {
            if (value.includes('/')) {
                throw new Error(`GET 路径中的${what}不能包含斜杠“/”（服务器会拒绝该请求）；请改用默认的 --method post`);
            }
        }
        const pathname = segments.map(([value]) => encodeURIComponent(value)).join('/');
        const query = new URLSearchParams();
        if (req.url !== undefined)
            query.append('url', req.url);
        if (req.imgUrl !== undefined)
            query.append('imgUrl', req.imgUrl);
        query.append('msgType', req.msgType);
        if (req.msgType === 'html')
            query.append('htmlHeight', String(req.htmlHeight));
        const qs = query.toString();
        const url = `${base}/${pathname}${qs === '' ? '' : `?${qs}`}`;
        if (url.length > MAX_GET_URL_LEN) {
            throw new Error(`GET URL 过长（${url.length} 字符，上限约 ${MAX_GET_URL_LEN}），请改用 --method post`);
        }
        return { method: 'get', url };
    }
    // msgType / htmlHeight always travel as query parameters, never in the JSON body.
    const query = new URLSearchParams();
    query.append('msgType', req.msgType);
    if (req.msgType === 'html')
        query.append('htmlHeight', String(req.htmlHeight));
    const url = `${base}/${encodeURIComponent(req.nickname)}?${query.toString()}`;
    const body = {};
    if (req.title !== undefined)
        body.title = req.title;
    body.msg = req.message;
    if (req.url !== undefined)
        body.url = req.url;
    if (req.imgUrl !== undefined)
        body.imgUrl = req.imgUrl;
    return { method: 'post', url, body };
}
export function truncate(text, maxChars) {
    const chars = Array.from(text);
    if (chars.length <= maxChars)
        return text;
    return `${chars.slice(0, maxChars).join('')}…`;
}
export function hintFor(status) {
    switch (status) {
        case 400:
            return '请求参数错误：检查昵称、标题与消息内容是否合法';
        case 403:
            return '内容被风控策略禁止，请修改消息内容后重试';
        case 404:
            return '该昵称未在 MeoW 注册，请确认接收者昵称';
        case 429:
            return '频率超限（普通用户：3 秒 1 条 / 每分钟 15 条 / 每小时 60 条 / 每天 1000 条），请等待后再试';
        case 500:
            return '服务器内部错误；消息是否送达未知，重试前请与用户确认';
        default:
            return undefined;
    }
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
export async function execute(plan, timeoutSeconds) {
    const init = {
        method: plan.method.toUpperCase(),
        signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutSeconds)) * 1000),
    };
    if (plan.method === 'post') {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(plan.body ?? {});
    }
    let response;
    try {
        response = await fetch(plan.url, init);
    }
    catch (err) {
        throw new UncertainError(`请求发送失败：${errorMessage(err)}。结果未知，消息可能已送达；请先确认再决定是否重发`);
    }
    let text;
    try {
        text = await response.text();
    }
    catch (err) {
        throw new UncertainError(`读取响应失败：${errorMessage(err)}。结果未知，消息可能已送达；请先确认再决定是否重发`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (err) {
        throw new UncertainError(`响应不是预期的 JSON（HTTP ${response.status}）：${errorMessage(err)}；原始响应：${truncate(text, 300)}。结果未知，请勿盲目重试`);
    }
    if (typeof parsed.status !== 'number') {
        throw new UncertainError(`响应缺少 status 字段（HTTP ${response.status}）：${truncate(text, 300)}。结果未知，请勿盲目重试`);
    }
    const serverMsg = typeof parsed.msg === 'string'
        ? parsed.msg
        : typeof parsed.message === 'string'
            ? parsed.message
            : undefined;
    const ok = parsed.status === 200 && parsed.data !== false;
    return {
        httpStatus: response.status,
        apiStatus: parsed.status,
        ok,
        serverMsg,
        data: parsed.data,
    };
}
export function configPath() {
    const home = homedir();
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
        return path.join(appData, 'meow', 'config.toml');
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'meow', 'config.toml');
    }
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg !== undefined && xdg.trim() !== '' ? xdg : path.join(home, '.config');
    return path.join(base, 'meow', 'config.toml');
}
function unescapeToml(value) {
    return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (match, esc) => {
        switch (esc) {
            case 'n':
                return '\n';
            case 'r':
                return '\r';
            case 't':
                return '\t';
            case '\\':
                return '\\';
            case '"':
                return '"';
            default:
                if (/^u[0-9a-fA-F]{4}$/.test(esc)) {
                    return String.fromCharCode(Number.parseInt(esc.slice(1), 16));
                }
                return match;
        }
    });
}
function escapeToml(value) {
    return value.replace(/[\\"\u0000-\u001f]/g, (char) => {
        switch (char) {
            case '\\':
                return '\\\\';
            case '"':
                return '\\"';
            case '\n':
                return '\\n';
            case '\r':
                return '\\r';
            case '\t':
                return '\\t';
            default:
                return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
        }
    });
}
export function loadFileConfig() {
    const file = configPath();
    if (!existsSync(file))
        return {};
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch (err) {
        throw new Error(`读取配置文件失败：${file}：${errorMessage(err)}`);
    }
    const config = {};
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(nickname|title|base_url)\s*=\s*"(.*)"\s*$/.exec(line);
        if (match === null)
            continue;
        const key = match[1];
        config[key] = unescapeToml(match[2] ?? '');
    }
    return config;
}
export function saveFileConfig(config) {
    const file = configPath();
    try {
        mkdirSync(path.dirname(file), { recursive: true });
    }
    catch (err) {
        throw new Error(`创建配置目录失败：${path.dirname(file)}：${errorMessage(err)}`);
    }
    const lines = [];
    if (config.nickname !== undefined) {
        lines.push(`nickname = "${escapeToml(config.nickname)}"`);
    }
    if (config.title !== undefined) {
        lines.push(`title = "${escapeToml(config.title)}"`);
    }
    if (config.base_url !== undefined) {
        lines.push(`base_url = "${escapeToml(config.base_url)}"`);
    }
    const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
    try {
        writeFileSync(file, text, 'utf8');
    }
    catch (err) {
        throw new Error(`写入配置文件失败：${file}：${errorMessage(err)}`);
    }
    return file;
}
