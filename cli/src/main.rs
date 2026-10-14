//! meow —— MeoW 消息推送 CLI
//!
//! 对接 <https://www.chuckfang.com/MeoW/api_doc.html> 的推送接口：
//!
//! - `GET  /{nickname}/{title}/{msg}`（title 可省略）
//! - `POST /{nickname}[/{title}]`（JSON 等请求体）
//!
//! 约定：
//! - 普通消息默认使用 POST JSON，避免路径编码问题；
//! - `msgType` / `htmlHeight` 始终作为查询参数，不进入 JSON Body；
//! - 推送不幂等，网络错误 / 500 / 超时后不自动重试；
//! - HTTP 状态含义忽略不计，业务结果以响应 JSON 的 `status` / `data` 为准。

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use url::Url;

const DEFAULT_BASE_URL: &str = "https://api.chuckfang.com";
const DEFAULT_TITLE: &str = "MeoW";
const USER_AGENT: &str = concat!("meow-cli/", env!("CARGO_PKG_VERSION"));
const MAX_GET_URL_LEN: usize = 7500;

// ---------------------------------------------------------------------------
// CLI 定义
// ---------------------------------------------------------------------------

#[derive(Parser)]
#[command(
    name = "meow",
    version,
    about = "MeoW 消息推送 CLI（api.chuckfang.com）",
    long_about = "向指定 MeoW 昵称推送文本或 HTML 消息。\n\n\
        昵称优先级：位置参数 > --nickname > 环境变量 MEOW_NICKNAME > 配置文件。\n\
        API 地址优先级：--base-url > 环境变量 MEOW_BASE_URL > 配置文件 > 默认 https://api.chuckfang.com。\n\n\
        注意：推送接口不幂等，本工具不会自动重试；失败后请先确认再决定是否重发。",
    after_help = "示例：\n  \
        meow push Azathoth \"服务部署完成\"\n  \
        meow push Azathoth \"<b>构建</b>成功\" --html --title 系统通知 -u https://ci.example.com\n  \
        meow push Azathoth - < long.txt\n  \
        meow push Azathoth \"预览请求\" --dry-run\n  \
        meow config set nickname Azathoth"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 向指定昵称推送一条消息
    Push(PushArgs),
    /// 查看或修改默认配置
    Config(ConfigArgs),
}

#[derive(Args)]
struct PushArgs {
    /// 位置参数：<消息> 或 <昵称> <消息>；消息为 "-" 时从标准输入读取
    #[arg(value_name = "NICKNAME|MSG", num_args = 1..=2)]
    positional: Vec<String>,

    /// 接收者昵称（省略时使用环境变量或配置文件中的默认昵称）
    #[arg(short, long, env = "MEOW_NICKNAME")]
    nickname: Option<String>,

    /// 消息标题，省略时默认 MeoW
    #[arg(short, long)]
    title: Option<String>,

    /// 点击通知后跳转的链接
    #[arg(short, long)]
    url: Option<String>,

    /// 通知图标 URL（建议 216×216 PNG）
    #[arg(long, value_name = "URL")]
    img_url: Option<String>,

    /// 以 HTML 渲染消息（等价于 --msg-type html）
    #[arg(long, conflicts_with_all = ["text", "msg_type"])]
    html: bool,

    /// 以纯文本发送（默认，等价于 --msg-type text）
    #[arg(long, conflicts_with_all = ["html", "msg_type"])]
    text: bool,

    /// 消息显示类型
    #[arg(long, value_name = "text|html", value_parser = ["text", "html"])]
    msg_type: Option<String>,

    /// HTML 显示高度（像素，隐含 HTML 类型；默认 200）
    #[arg(long, value_name = "PX")]
    html_height: Option<u32>,

    /// 请求方法：post（默认，推荐）或 get
    #[arg(short, long, value_name = "get|post", default_value = "post", value_parser = ["get", "post"])]
    method: String,

    /// HTTP 超时（秒）
    #[arg(long, default_value_t = 15, value_name = "SECONDS")]
    timeout: u64,

    /// 只打印将要发送的请求，不实际发送
    #[arg(long)]
    dry_run: bool,

    /// 以单行 JSON 输出结果，便于程序解析
    #[arg(long)]
    json: bool,

    /// 覆盖 API 基地址
    #[arg(long, env = "MEOW_BASE_URL", value_name = "URL")]
    base_url: Option<String>,
}

#[derive(Args)]
struct ConfigArgs {
    #[command(subcommand)]
    action: Option<ConfigAction>,
}

#[derive(Subcommand)]
enum ConfigAction {
    /// 设置配置项（值为空字符串时清除该项）
    Set {
        /// 配置项：nickname、title 或 base_url
        key: String,
        /// 配置值
        value: String,
    },
}

// ---------------------------------------------------------------------------
// 配置文件
// ---------------------------------------------------------------------------

#[derive(Default, Clone, Serialize, Deserialize)]
struct FileConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
}

fn config_path() -> Result<PathBuf> {
    let dir = dirs::config_dir().ok_or_else(|| anyhow!("无法确定系统配置目录"))?;
    Ok(dir.join("meow").join("config.toml"))
}

fn load_file_config() -> Result<FileConfig> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(FileConfig::default());
    }
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("读取配置文件失败：{}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(FileConfig::default());
    }
    toml::from_str(&text).with_context(|| format!("解析配置文件失败：{}", path.display()))
}

fn save_file_config(cfg: &FileConfig) -> Result<PathBuf> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("创建配置目录失败：{}", parent.display()))?;
    }
    let text = toml::to_string_pretty(cfg).context("序列化配置失败")?;
    std::fs::write(&path, text).with_context(|| format!("写入配置文件失败：{}", path.display()))?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// 请求模型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Method {
    Get,
    Post,
}

impl Method {
    fn parse(s: &str) -> Method {
        match s {
            "get" => Method::Get,
            _ => Method::Post,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MsgType {
    Text,
    Html,
}

impl MsgType {
    fn as_str(self) -> &'static str {
        match self {
            MsgType::Text => "text",
            MsgType::Html => "html",
        }
    }

    fn is_html(self) -> bool {
        self == MsgType::Html
    }
}

struct PushRequest {
    nickname: String,
    title: Option<String>,
    message: String,
    url: Option<String>,
    img_url: Option<String>,
    msg_type: MsgType,
    html_height: u32,
    method: Method,
    base_url: Url,
}

#[derive(Debug)]
struct Plan {
    method: Method,
    url: String,
    body: Option<Value>,
}

fn build_plan(req: &PushRequest) -> Result<Plan> {
    let mut url = req.base_url.clone();
    match req.method {
        Method::Get => {
            // 服务器前端（Tomcat）会拒绝路径中的编码斜杠 %2F，因此 GET 的三个
            // 路径段都不能包含“/”。普通消息请使用默认的 POST JSON。
            for (value, what) in [(&req.nickname, "昵称")]
                .into_iter()
                .chain(req.title.as_ref().map(|t| (t, "标题")))
                .chain(std::iter::once((&req.message, "消息")))
            {
                if value.contains('/') {
                    bail!(
                        "GET 路径中的{what}不能包含斜杠“/”（服务器会拒绝该请求）；请改用默认的 --method post"
                    );
                }
            }
            {
                let mut segments = url
                    .path_segments_mut()
                    .map_err(|_| anyhow!("API 基地址不支持路径拼接：{}", req.base_url))?;
                segments.push(&req.nickname);
                if let Some(title) = &req.title {
                    segments.push(title);
                }
                segments.push(&req.message);
            }
            {
                let mut query = url.query_pairs_mut();
                if let Some(link) = &req.url {
                    query.append_pair("url", link);
                }
                if let Some(icon) = &req.img_url {
                    query.append_pair("imgUrl", icon);
                }
                query.append_pair("msgType", req.msg_type.as_str());
                if req.msg_type.is_html() {
                    query.append_pair("htmlHeight", &req.html_height.to_string());
                }
            }
            let encoded = url.to_string();
            if encoded.len() > MAX_GET_URL_LEN {
                bail!(
                    "GET URL 过长（{} 字符，上限约 {}），请改用 --method post",
                    encoded.len(),
                    MAX_GET_URL_LEN
                );
            }
            Ok(Plan {
                method: Method::Get,
                url: encoded,
                body: None,
            })
        }
        Method::Post => {
            {
                let mut segments = url
                    .path_segments_mut()
                    .map_err(|_| anyhow!("API 基地址不支持路径拼接：{}", req.base_url))?;
                segments.push(&req.nickname);
            }
            {
                // msgType / htmlHeight 始终走查询参数，不进入 JSON Body。
                let mut query = url.query_pairs_mut();
                query.append_pair("msgType", req.msg_type.as_str());
                if req.msg_type.is_html() {
                    query.append_pair("htmlHeight", &req.html_height.to_string());
                }
            }
            let mut body = Map::new();
            if let Some(title) = &req.title {
                body.insert("title".into(), json!(title));
            }
            body.insert("msg".into(), json!(req.message));
            if let Some(link) = &req.url {
                body.insert("url".into(), json!(link));
            }
            if let Some(icon) = &req.img_url {
                body.insert("imgUrl".into(), json!(icon));
            }
            Ok(Plan {
                method: Method::Post,
                url: url.to_string(),
                body: Some(Value::Object(body)),
            })
        }
    }
}

// ---------------------------------------------------------------------------
// 响应模型
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ApiResponse {
    status: i64,
    #[serde(alias = "message")]
    msg: Option<String>,
    data: Option<Value>,
}

struct Outcome {
    http_status: u16,
    api_status: i64,
    ok: bool,
    server_msg: Option<String>,
    data: Option<Value>,
}

fn execute(plan: &Plan, timeout: Duration) -> Result<Outcome> {
    let client = Client::builder()
        .timeout(timeout)
        .user_agent(USER_AGENT)
        .build()
        .context("创建 HTTP 客户端失败")?;
    let request = match plan.method {
        Method::Get => client.get(&plan.url),
        Method::Post => client
            .post(&plan.url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(plan.body.as_ref().expect("POST 请求必须有 body")),
    };
    let response = request.send().map_err(|err| {
        anyhow!("请求发送失败：{err:#}。结果未知，消息可能已送达；请先确认再决定是否重发")
    })?;
    let http_status = response.status().as_u16();
    let text = response.text().context("读取响应失败")?;
    let parsed: ApiResponse = serde_json::from_str(&text).map_err(|err| {
        anyhow!(
            "响应不是预期的 JSON（HTTP {http_status}）：{err}；原始响应：{}。结果未知，请勿盲目重试",
            truncate(&text, 300)
        )
    })?;
    let ok = parsed.status == 200 && !matches!(parsed.data, Some(Value::Bool(false)));
    Ok(Outcome {
        http_status,
        api_status: parsed.status,
        ok,
        server_msg: parsed.msg,
        data: parsed.data,
    })
}

fn hint_for(status: i64) -> Option<&'static str> {
    match status {
        400 => Some("请求参数错误：检查昵称、标题与消息内容是否合法"),
        403 => Some("内容被风控策略禁止，请修改消息内容后重试"),
        404 => Some("该昵称未在 MeoW 注册，请确认接收者昵称"),
        429 => Some("频率超限（普通用户：3 秒 1 条 / 每分钟 15 条 / 每小时 60 条 / 每天 1000 条），请等待后再试"),
        500 => Some("服务器内部错误；消息是否送达未知，重试前请与用户确认"),
        _ => None,
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max_chars).collect();
        out.push('…');
        out
    }
}

// ---------------------------------------------------------------------------
// 结果输出
// ---------------------------------------------------------------------------

#[derive(Default, Serialize)]
struct JsonReport {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    msg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<&'static str>,
}

fn print_json(report: &JsonReport) {
    match serde_json::to_string(report) {
        Ok(line) => println!("{line}"),
        Err(err) => eprintln!("✘ 序列化输出失败：{err}"),
    }
}

// ---------------------------------------------------------------------------
// push 子命令
// ---------------------------------------------------------------------------

fn run_push(args: PushArgs) -> ExitCode {
    let json_mode = args.json;
    match push(&args) {
        Ok(code) => code,
        Err(err) => {
            let text = format!("{err:#}");
            if json_mode {
                print_json(&JsonReport {
                    ok: false,
                    msg: Some(text),
                    ..Default::default()
                });
            } else {
                eprintln!("✘ {text}");
            }
            ExitCode::from(1)
        }
    }
}

fn push(args: &PushArgs) -> Result<ExitCode> {
    let file = load_file_config()?;

    // 位置参数解析：1 个 = 消息；2 个 = 昵称 + 消息。
    let (positional_nick, message_arg) = match args.positional.as_slice() {
        [msg] => (None, msg.clone()),
        [nick, msg] => (Some(nick.clone()), msg.clone()),
        _ => unreachable!("clap 已限制位置参数为 1..=2 个"),
    };

    let nickname = match (positional_nick, args.nickname.clone()) {
        (Some(pos), Some(flag)) if pos != flag => {
            bail!("位置参数中的昵称“{pos}”与 --nickname“{flag}”冲突")
        }
        (Some(pos), _) => pos,
        (None, Some(flag)) => flag,
        (None, None) => match file.nickname.clone() {
            Some(name) if !name.trim().is_empty() => name,
            _ => bail!(
                "缺少接收者昵称。用法：meow push <昵称> <消息>，\
                 或先用 meow config set nickname <昵称> 设置默认昵称"
            ),
        },
    };
    let nickname = nickname.trim().to_string();
    if nickname.is_empty() {
        bail!("昵称不能为空");
    }
    if nickname.contains('/') {
        bail!("昵称不允许包含斜杠：{nickname}");
    }
    if nickname.chars().any(char::is_control) {
        bail!("昵称包含控制字符，请检查输入");
    }

    let message = if message_arg == "-" {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .context("读取标准输入失败")?;
        buf.trim_end_matches(['\n', '\r']).to_string()
    } else {
        message_arg
    };
    if message.trim().is_empty() {
        bail!("消息内容不能为空");
    }

    let title = match args.title.clone() {
        Some(title) => {
            if title.is_empty() {
                bail!("标题不能为空；省略 --title 时默认使用 {DEFAULT_TITLE}");
            }
            Some(title)
        }
        None => file.title.clone().filter(|t| !t.is_empty()),
    };

    let explicit_type = if let Some(kind) = &args.msg_type {
        Some(kind.as_str())
    } else if args.html {
        Some("html")
    } else if args.text {
        Some("text")
    } else {
        None
    };
    let msg_type = match (explicit_type, args.html_height) {
        (Some("text"), Some(_)) => {
            bail!("--html-height 仅在 HTML 消息（--html 或 --msg-type html）时可用")
        }
        (Some("text"), None) => MsgType::Text,
        (Some(_), _) => MsgType::Html,
        (None, Some(_)) => MsgType::Html,
        (None, None) => MsgType::Text,
    };
    let html_height = match args.html_height {
        Some(0) => bail!("--html-height 必须大于 0"),
        Some(h) => h,
        None => 200,
    };

    let base_url = args
        .base_url
        .clone()
        .or_else(|| file.base_url.clone())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let base_url = Url::parse(&base_url).with_context(|| format!("API 基地址无效：{base_url}"))?;
    if !matches!(base_url.scheme(), "http" | "https") {
        bail!("API 基地址必须是 http/https：{base_url}");
    }

    let request = PushRequest {
        nickname: nickname.clone(),
        title,
        message,
        url: args.url.clone(),
        img_url: args.img_url.clone(),
        msg_type,
        html_height,
        method: Method::parse(&args.method),
        base_url,
    };
    let plan = build_plan(&request)?;

    if args.dry_run {
        if args.json {
            let payload = json!({
                "dry_run": true,
                "method": plan.method.as_str(),
                "url": plan.url,
                "content_type": if plan.method == Method::Post { Some("application/json") } else { None },
                "body": plan.body,
            });
            println!("{}", serde_json::to_string_pretty(&payload)?);
        } else {
            println!("{} {}", plan.method.as_str(), plan.url);
            if let Some(body) = &plan.body {
                println!("Content-Type: application/json");
                println!();
                println!("{}", serde_json::to_string_pretty(body)?);
            }
        }
        return Ok(ExitCode::SUCCESS);
    }

    let outcome = execute(&plan, Duration::from_secs(args.timeout))?;
    let report = JsonReport {
        ok: outcome.ok,
        status: Some(outcome.api_status),
        http_status: Some(outcome.http_status),
        msg: outcome.server_msg.clone(),
        data: outcome.data.clone(),
        nickname: Some(nickname.clone()),
        hint: if outcome.ok {
            None
        } else {
            hint_for(outcome.api_status)
        },
    };

    if args.json {
        print_json(&report);
    } else if outcome.ok {
        let text = outcome
            .server_msg
            .clone()
            .unwrap_or_else(|| "发送成功".to_string());
        println!("✔ {text}（接收者：{nickname}）");
    } else {
        let text = outcome
            .server_msg
            .clone()
            .unwrap_or_else(|| "未知错误".to_string());
        eprintln!("✘ 推送失败（业务状态码 {}）：{text}", outcome.api_status);
        if let Some(hint) = hint_for(outcome.api_status) {
            eprintln!("  提示：{hint}");
        }
    }

    Ok(if outcome.ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

// ---------------------------------------------------------------------------
// config 子命令
// ---------------------------------------------------------------------------

fn run_config(args: ConfigArgs) -> Result<ExitCode> {
    let path = config_path()?;
    match args.action {
        None => {
            let cfg = load_file_config()?;
            println!("配置文件：{}", path.display());
            println!(
                "nickname = {}",
                cfg.nickname.as_deref().unwrap_or("（未设置）")
            );
            println!(
                "title    = {}",
                cfg.title.as_deref().unwrap_or("（未设置，默认 MeoW）")
            );
            println!(
                "base_url = {}",
                cfg.base_url.as_deref().unwrap_or(DEFAULT_BASE_URL)
            );
        }
        Some(ConfigAction::Set { key, value }) => {
            let mut cfg = load_file_config()?;
            let cleared = value.is_empty();
            let value = if cleared { None } else { Some(value) };
            match key.as_str() {
                "nickname" => cfg.nickname = value,
                "title" => cfg.title = value,
                "base_url" | "base-url" => {
                    if let Some(v) = &value {
                        let parsed =
                            Url::parse(v).with_context(|| format!("base_url 无效：{v}"))?;
                        if !matches!(parsed.scheme(), "http" | "https") {
                            bail!("base_url 必须是 http/https");
                        }
                    }
                    cfg.base_url = value;
                }
                other => bail!("未知配置项“{other}”；可选：nickname、title、base_url"),
            }
            let path = save_file_config(&cfg)?;
            if cleared {
                println!("已清除 {key}（{}）", path.display());
            } else {
                println!("已更新 {key}（{}）", path.display());
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Push(args) => run_push(args),
        Command::Config(args) => match run_config(args) {
            Ok(code) => code,
            Err(err) => {
                eprintln!("✘ {err:#}");
                ExitCode::from(1)
            }
        },
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request(method: Method) -> PushRequest {
        PushRequest {
            nickname: "Azathoth".into(),
            title: Some("系统通知".into()),
            message: "你好<b>世界".into(),
            url: Some("https://example.com/a b".into()),
            img_url: None,
            msg_type: MsgType::Html,
            html_height: 300,
            method,
            base_url: Url::parse("https://api.chuckfang.com").unwrap(),
        }
    }

    #[test]
    fn get_plan_encodes_path_and_query() {
        let plan = build_plan(&sample_request(Method::Get)).unwrap();
        assert_eq!(plan.method, Method::Get);
        assert!(plan.url.starts_with(
            "https://api.chuckfang.com/Azathoth/%E7%B3%BB%E7%BB%9F%E9%80%9A%E7%9F%A5/"
        ));
        assert!(plan.url.contains("%3Cb%3E"));
        assert!(plan
            .url
            .contains("%E4%BD%A0%E5%A5%BD%3Cb%3E%E4%B8%96%E7%95%8C"));
        assert!(plan.url.contains("msgType=html"));
        assert!(plan.url.contains("htmlHeight=300"));
        assert!(
            plan.url.contains("url=https%3A%2F%2Fexample.com%2Fa+b")
                || plan.url.contains("url=https%3A%2F%2Fexample.com%2Fa%20b")
        );
        assert!(plan.body.is_none());
    }

    #[test]
    fn get_plan_without_title_uses_short_path() {
        let mut req = sample_request(Method::Get);
        req.title = None;
        req.message = "hello world".into();
        let plan = build_plan(&req).unwrap();
        assert!(plan
            .url
            .starts_with("https://api.chuckfang.com/Azathoth/hello%20world?"));
    }

    #[test]
    fn post_plan_keeps_type_in_query_and_fields_in_body() {
        let plan = build_plan(&sample_request(Method::Post)).unwrap();
        assert_eq!(plan.method, Method::Post);
        assert_eq!(
            plan.url,
            "https://api.chuckfang.com/Azathoth?msgType=html&htmlHeight=300"
        );
        let body = plan.body.unwrap();
        assert_eq!(body["title"], "系统通知");
        assert_eq!(body["msg"], "你好<b>世界");
        assert_eq!(body["url"], "https://example.com/a b");
        assert!(body.get("msgType").is_none());
        assert!(body.get("htmlHeight").is_none());
    }

    #[test]
    fn get_plan_rejects_slash_in_path_segments() {
        let mut req = sample_request(Method::Get);
        req.message = "a/b".into();
        let err = build_plan(&req).unwrap_err().to_string();
        assert!(err.contains("斜杠"), "unexpected error: {err}");

        let mut req = sample_request(Method::Get);
        req.message = "fine".into();
        req.title = Some("a/b".into());
        assert!(build_plan(&req).is_err());
    }

    #[test]
    fn post_roundtrip_against_mock_server() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(String::new()));
        let cap = Arc::clone(&captured);
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut data: Vec<u8> = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&buf[..n]);
                if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..pos]).to_string();
                    let len: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (k, v) = line.split_once(':')?;
                            if k.eq_ignore_ascii_case("content-length") {
                                v.trim().parse().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    if data.len() >= pos + 4 + len {
                        break;
                    }
                }
            }
            *cap.lock().unwrap() = String::from_utf8_lossy(&data).to_string();
            let body = "{\"status\":200,\"data\":true,\"msg\":\"发送成功\"}";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        });

        let mut req = sample_request(Method::Post);
        req.base_url = Url::parse(&format!("http://{addr}")).unwrap();
        let plan = build_plan(&req).unwrap();
        let outcome = execute(&plan, Duration::from_secs(5)).unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.api_status, 200);

        let raw = captured.lock().unwrap().clone();
        assert!(
            raw.starts_with("POST /Azathoth?msgType=html&htmlHeight=300 HTTP/1.1"),
            "unexpected request line: {raw}"
        );
        assert!(raw
            .to_lowercase()
            .contains("content-type: application/json"));
        assert!(raw.contains("你好<b>世界"), "body not captured: {raw}");
    }
}
